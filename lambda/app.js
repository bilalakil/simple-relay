const shortid = require('shortid');
const AWS = require('aws-sdk');

shortid.characters('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_');

const DDB = new AWS.DynamoDB({ apiVersion: '2012-10-08' });
let APIGW;

const {
  CONNECTION_TABLE_NAME,
  SESSION_TABLE_NAME,
  MESSAGE_TABLE_NAME,
  APIGW_ENDPOINT, // Not available/needed in `webSocketHandler`
} = process.env;

const SEP = '.'; // '.' is not included in `shortid` or AWS IDs, and is query string safe
const OPEN_SESSION_ID = `${SEP}open`;

const res = (statusCode) => ({ statusCode });
const success = res(200);
const error = () => {
  throw new Error();
  return res(500);
};

const newId = () => shortid.generate();

/**
 * `memberList` is an ordered array of <memberId>|[<connId>]
 *
 * Returns `{ memberNum, connId }` for the requested `memberId`,
 * or `{}` if `memberId` does not exist in the list.
 */
const decodeMemberList = (memberList, memberId) => {
  const memberNum = memberList.findIndex((_) => _.startsWith(memberId + SEP));
  if (memberNum === -1) return {};

  const s = memberList[memberNum];
  const connId = s.substr(s.indexOf(SEP) + 1);
  return {
    memberNum,
    connId,
  };
};

const communicate = async (connId, payload) => {
  try {
    await APIGW.postToConnection({
      ConnectionId: connId,
      Data: JSON.stringify(payload),
    }).promise();
  } catch (e) {
    if (e.statusCode === 410) {
      await DDB.deleteItem({
        TableName: CONNECTION_TABLE_NAME,
        Key: { id: { S: connId } },
      }).promise();
    } else throw e;
  }
};

const commToAllMembers = (memberList, payload) => Promise.all(
  memberList
    .map((_) => _.substr(_.indexOf(SEP) + 1))
    .filter(Boolean)
    .map((connId) => communicate(connId, payload)),
);

const setConn = (event, sessionKey) => DDB.putItem({
  TableName: CONNECTION_TABLE_NAME,
  Item: {
    id: { S: event.requestContext.connectionId },
    sessionKey: { M: sessionKey },
  },
}).promise();

const deleteConn = (connId) => DDB.deleteItem({
  TableName: CONNECTION_TABLE_NAME,
  Key: { id: { S: connId } },
}).promise();

const joinSession = async (event) => {
  const qs = event.queryStringParameters;
  const connId = event.requestContext.connectionId;

  // Validate input
  // `?sessionType=<string>[&targetNumMembers=<num>][&private=true][&id=<string>]`
  //
  // - `targetNumMembers` must and can only be provided if `id` is not
  // - `targetNumMembers`, when provided, must be > 1
  // - `private` and `id` are mutually exclusive
  if (!(
    qs.sessionType
    && (
      (
        !Number.isNaN(parseInt(qs.targetNumMembers, 10))
        && typeof qs.id === 'undefined'
      )
      || (
        typeof qs.targetNumMembers === 'undefined'
        && qs.id
      )
    )
    && (typeof qs.private === 'undefined' || typeof qs.id === 'undefined')
    && (typeof qs.id === 'undefined' || typeof qs.private === 'undefined')
  )) return error();

  // Extract input
  const targetNumMembers = parseInt(qs.targetNumMembers, 10);
  if (targetNumMembers <= 1) return error();

  const priv = !!qs.private;
  const joiningPrivateSession = !!qs.id;
  const pblc = !priv && !joiningPrivateSession;
  const standardId = newId()
    + SEP + (targetNumMembers ? targetNumMembers.toString() : '');
  const memberId = newId();
  const sessionKey = { type: { S: qs.sessionType } };
  const openSessionKey = targetNumMembers
    ? {
      ...sessionKey,
      id: { S: OPEN_SESSION_ID + SEP + targetNumMembers.toString() },
    }
    : undefined;

  let openSession;
  let lastMembersChangeNum = -1;
  let sessionAlreadyExists = joiningPrivateSession;
  let curMembers = [];
  let privateId;

  // If public, check if there's an open session
  if (pblc) {
    openSession = await (DDB.getItem({
      TableName: SESSION_TABLE_NAME,
      Key: openSessionKey,
      ConsistentRead: true,
    }).promise());

    if (openSession.Item) sessionAlreadyExists = true;
    else openSession = undefined;
  }

  // Set the destination session's ID
  // (skipping if `qs.id` is provided because that'll use a `begins-with` condition)
  if (openSession) sessionKey.id = openSession.Item.openSessionId;
  else if (priv) {
    privateId = newId();
    sessionKey.id = { S: privateId + SEP + standardId };
  } else if (!qs.id) sessionKey.id = { S: standardId };

  // If there's an open or private session to join, get its current details
  if (sessionAlreadyExists) {
    const cur = await (DDB.getItem({
      TableName: SESSION_TABLE_NAME,
      Key: sessionKey,
      ConsistentRead: true,
      ...(qs.id // `begins-with` condition used when joining a private session
        ? {
          ConditionExpression: 'begins_with(id, :privateId)',
          ExpressionAttributeValues: {
            ':privateId': { S: privateId + SEP },
          },
        }
        : {}
      ),
    }).promise());

    if (!cur.Item) {
      // If there's an orphaned open session then delete it manually,
      // because it won't be able to play well with automated expiration
      if (openSession) {
        await (DDB.deleteItem({
          TableName: SESSION_TABLE_NAME,
          Key: openSessionKey,
        }).promise());
      }

      return error();
    }

    sessionKey.id = cur.Item.id;
    lastMembersChangeNum = parseInt(cur.Item.membersChangeNum.N, 10);
    curMembers = cur.Item.members.SS;
    if (curMembers.length >= targetNumMembers) return error();
  }

  // Add ourselves to the member list
  const newMembers = [...curMembers];
  newMembers.push(memberId + SEP + connId);

  // Create or overwrite with the new session details
  await (DDB.putItem({
    TableName: SESSION_TABLE_NAME,
    Item: {
      ...sessionKey,
      members: { SS: newMembers },
      membersChangeNum: { N: (lastMembersChangeNum + 1).toString() },
    },
    ...(sessionAlreadyExists
      ? { // Overwrite condition
        ConditionExpression: 'membersChangeNum = :lastMembersChangeNum',
        ExpressionAttributeValues: {
          ':lastMembersChangeNum': { N: lastMembersChangeNum.toString() },
        },
      }
      : { // Create condition
        ConditionExpression: 'attribute_not_exists(#type)',
        ExpressionAttributeNames: { '#type': 'type' },
      }
    ),
  }).promise());

  // If it's a new public session, create open session link
  if (pblc && !sessionAlreadyExists) {
    await (DDB.putItem({
      TableName: SESSION_TABLE_NAME,
      Item: {
        ...sessionKey,
        id: openSessionKey.id,
        openSessionId: sessionKey.id,
      },
    }).promise());
  }

  // Record connection to the session
  await setConn(event, sessionKey);

  // If the session is full...
  if (newMembers.length === targetNumMembers) {
    // Destroy open session link
    if (openSession) {
      await (DDB.deleteItem({
        TableName: SESSION_TABLE_NAME,
        Key: openSessionKey,
      }).promise());
    }

    // TODO
    // Handle session start (i.e. messaging members) in a separate lambda
    // (because we can't communicate with the current member during `$connect`)
  }

  return success;
};

const rejoinSession = async (event) => {
  const qs = event.queryStringParameters;
  const connId = event.requestContext.connectionId;

  // Validate input
  // `?sessionType=<string>&sessionId=<string>&memberId=<string>`
  if (!(qs.sessionType && qs.sessionId && qs.memberId)) return error();

  const sessionKey = {
    type: { S: qs.sessionType },
    id: { S: qs.sessionId },
  };

  const session = await (DDB.getItem({
    TableName: SESSION_TABLE_NAME,
    Key: sessionKey,
  }).promise());

  if (!session.Item) return error();
  const lastMembersChangeNum = parseInt(session.Item.membersChangeNum.N, 10);
  const memberList = session.Item.members.SS;

  const {
    memberNum,
    connId: oldConnId,
  } = decodeMemberList(memberList, qs.memberId);

  if (typeof memberNum === 'undefined') return error();

  if (oldConnId) {
    await Promise.all([
      deleteConn(oldConnId),
      communicate(oldConnId, { type: 'CONNECTED_ELSEWHERE' }),
    ]);
  }

  memberList[memberNum] = qs.memberId + SEP + connId;

  await (DDB.putItem({
    TableName: SESSION_TABLE_NAME,
    Item: {
      ...sessionKey,
      members: { SS: memberList },
      membersChangeNum: { N: (lastMembersChangeNum + 1).toString() },
    },
    ConditionExpression: 'membersChangeNum = :lastChangeNum',
    ExpressionAttributeValues: {
      ':lastChangeNum': { N: lastMembersChangeNum.toString() },
    },
  }).promise());

  const putConnection = setConn(event, sessionKey);

  let comms = [];
  if (!oldConnId)
    comms = memberList
      .map((memberNConnId, i) => ({ i, memberNConnId }))
      .filter(({ i }) => i !== memberNum)
      .map(({ i, memberNConnId }) => communicate(
        memberNConnId.substr(memberNConnId.indexOf(SEP) + 1),
        {
          type: 'MEMBER_RECONNECTED',
          memberNum: i,
        },
      ));

  await Promise.all([putConnection, ...comms]);

  return success;
};

const connect = (event) => {
  const qs = event.queryStringParameters;
  if (!qs) return error();

  if (typeof qs.sessionId !== 'undefined') return rejoinSession(event);
  if (typeof qs.sessionType !== 'undefined') return joinSession(event);
  return error();
};

const disconnect = async (event) => {
  const connId = event.requestContext.connectionId;

  // Delete connection, returning original session key
  const conn = await (DDB.deleteItem({
    TableName: CONNECTION_TABLE_NAME,
    Key: { id: { S: connId } },
    ReturnValues: 'ALL_OLD',
  }).promise());

  if (!conn.Attributes) return success;

  // Get session
  const session = await (DDB.getItem({
    TableName: SESSION_TABLE_NAME,
    Key: conn.Attributes.sessionKey.M,
  }).promise());

  const promises = [];

  if (session.Item) {
    // Find this member within the session
    const members = session.Item.members.SS;
    const memberNum = members.findIndex((_) => _.endsWith(SEP + connId));

    if (memberNum !== -1) {
      const id = session.Item.id.S;
      const targetNumMembers = parseInt(id.substr(id.lastIndexOf(SEP) + 1), 10);
      // TODO: Consider private sessions
      const isOpen = members.length < targetNumMembers;

      // Completely remove member from the session if it's still open
      if (isOpen) members.splice(memberNum, 1);
      else { // Otherwise just clear connection ID to let them reconnect
        const s = members[memberNum];
        members[memberNum] = s.substr(0, s.indexOf(SEP) + 1);
      }

      // If the session is now empty...
      if (members.length === 0) {
        // delete it...
        promises.push(DDB.deleteItem({
          TableName: SESSION_TABLE_NAME,
          Key: conn.Attributes.sessionKey.M,
        }).promise());

        if (isOpen) {
          // and the open session record that points to it
          promises.push(DDB.deleteItem({
            TableName: SESSION_TABLE_NAME,
            Key: {
              ...conn.Attributes.sessionKey.M,
              id: { S: OPEN_SESSION_ID + SEP + targetNumMembers.toString() },
            },
          }).promise());
        }
      } else {
        // Otherwise update the session
        const lastMembersChangeNum = parseInt(session.Item.membersChangeNum.N, 10);

        await (DDB.putItem({
          TableName: SESSION_TABLE_NAME,
          Item: {
            ...conn.Attributes.sessionKey.M,
            members: { SS: members },
            membersChangeNum: { N: (lastMembersChangeNum + 1).toString() },
          },
          ConditionExpression: 'membersChangeNum = :lastChangeNum',
          ExpressionAttributeValues: {
            ':lastChangeNum': { N: lastMembersChangeNum.toString() },
          },
        }).promise());
      }

      // If the session's started, tell its members that someone's disconnected
      if (!isOpen) {
        promises.push(commToAllMembers(
          members.filter((_, i) => i !== memberNum),
          {
            type: 'MEMBER_DISCONNECTED',
            memberNum,
          },
        ));
      }
    }
  }

  await Promise.all(promises);

  return success;
};

/**
 * `event.body = { action: "endSession" }`
 */
const endSession = async (conn) => {
  // TODO: Ensure session has started...

  const session = await (DDB.deleteItem({
    TableName: SESSION_TABLE_NAME,
    Key: conn.Item.sessionKey.M,
    ReturnValues: 'ALL_OLD',
  }).promise());

  if (!session.Attributes) {
    await communicate(conn.Item.id.S, { type: 'INVALID_CONNECTION' });
    return error();
  }

  const comms = commToAllMembers(
    session.Attributes.members.SS,
    { type: 'SESSION_ENDED' },
  );

  const delConns = DDB.batchWriteItem({
    RequestItems: {
      [CONNECTION_TABLE_NAME]: session.Attributes.members.SS
        .map((_) => _.substr(_.indexOf(SEP) + 1))
        .filter(Boolean)
        .map((connId) => ({ DeleteRequest: { Key: { id: { S: connId } } } })),
    },
  }).promise();

  await Promise.all([comms, delConns]);

  return success;
};

/**
 * `event.body = { action: "heartbeat"[, inclMessagesAfter: <int>] }`
 *
 * Alternatively triggered when `sendMessage` fails due to having an old message number.
 */
const heartbeat = async (conn, body) => {
  // TODO: Ensure session has started...
};

/**
 * `event.body = { action: "sendMessage", payload: <string>[, pinned: <bool>] }`
 */
const sendMessage = async (conn, body) => {
  // TODO: Ensure session has started...
};

/**
 * - `event.queryStringParameters` (available on `$connect` only)
 * - `event.requestContext.routeKey` (`'$connect'`, `"$disconnect"` or `"$default"`)
 * - `event.requestContext.connectionId`
 * - `event.body` (available on `$default` only)
 */
exports.webSocketHandler = async (event) => {
  APIGW = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: `${event.requestContext.domainName}/${event.requestContext.stage}`,
  });

  const route = event.requestContext.routeKey;

  if (route === '$connect') return connect(event);
  if (route === '$disconnect') return disconnect(event);

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return error();
  }

  const actions = ['endSession', 'heartbeat', 'sendMessage'];
  const fns = [endSession, heartbeat, sendMessage];
  const action = actions.indexOf(body.action);
  if (action === -1) return error();

  const connId = event.requestContext.connectionId;
  const conn = await (DDB.getItem({
    TableName: CONNECTION_TABLE_NAME,
    Key: { id: { S: connId } },
  }).promise());

  if (!conn.Item) {
    await communicate(connId, { type: 'INVALID_CONNECTION' });
    return success;
  }

  return fns[action](conn, body);
};

/**
```
event = { Records: [ {
  OldImage: <item>,
  NewImage: <item>,
} ] }
```

Do not change the session in this handler, to avoid trigger loops
 */
exports.sessionMembersChangedHandler = async (event) => {
  APIGW = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: APIGW_ENDPOINT,
  });

  const changes = event.Records[0].dynamodb;

  const session = changes.NewImage;
  if (!session) return success;

  const id = session.id.S;
  if (id.startsWith(OPEN_SESSION_ID)) return success;

  const targetNumMembers = parseInt(id.substr(id.indexOf(SEP) + 1), 10);
  const oldMembers = changes.OldImage ? changes.OldImage.members.SS : [];
  const newMembers = session.members.SS;
  const membersChanged = JSON.stringify(oldMembers) !== JSON.stringify(newMembers);
  const sessionJustStarted = newMembers.length === targetNumMembers
    && oldMembers.length !== targetNumMembers;

  if (!membersChanged) return success;

  if (sessionJustStarted) {
    await Promise.all(
      newMembers.map((memberNConnId, i) => communicate(
        memberNConnId.substr(memberNConnId.indexOf(SEP) + 1),
        {
          type: 'SESSION_CONNECT',
          sessionType: session.type.S,
          sessionId: session.id.S,
          memberNum: i,
          memberId: memberNConnId.substr(0, memberNConnId.indexOf(SEP)),
        },
      )),
    );
  }

  return success;
};
