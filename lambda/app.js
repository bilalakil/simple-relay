// TODO: Review "encoded" strings - what's the point?
// TODO: Review race conditions

const shortid = require('shortid');
const AWS = require('aws-sdk');

shortid.characters('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_');

const DDB = new AWS.DynamoDB({ apiVersion: '2012-10-08' });
let APIGW;

const {
  CONNECTION_TABLE_NAME,
  SESSION_TABLE_NAME,
  APIGW_ENDPOINT, // Not available/needed in `webSocketHandler`
} = process.env;

const SEP = '.'; // '.' is not included in `shortid` or AWS IDs, and is query string safe
const OPEN_SESSION_ID = `${SEP}open`;

const res = (statusCode) => ({ statusCode });
const success = res(200);
const error = () => { // TODO: Understand the different kinds of error handling
  throw new Error();
  return res(500);
};

const newId = () => shortid.generate();

/**
 * `s` is "<memberId>.[<connId>]".
 *
 * `connId` will be returned as a blank string if it's not set.
 */
const decodeMemberNConnId = (s) => {
  const memberId = s.substr(0, s.indexOf(SEP));
  const connId = s.substr(s.indexOf(SEP) + 1);
  return { memberId, connId };
};

/**
 * `memberList` is a DynamoDB list of strings: `[ { S: <str> }, ... ]`.
 * Each string is of format "<memberId>.[<connId>]".
 *
 * Returns `[{ memberNum, memberId, connId }]` for all members.
 */
const decodeMemberList = (rawMembers) => rawMembers.map(({ S: memberNConnId }, i) => ({
  memberNum: i,
  ...decodeMemberNConnId(memberNConnId),
}));

/**
 * `memberList` is a DynamoDB list of strings: `[ { S: <str> }, ... ]`.
 * Each string is of format "<memberId>.[<connId>]".
 *
 * Returns `{ memberNum, memberId, connId }` for the requested `memberId` or `connId`,
 * or `{ memberNum: -1 }` if no match is found.
 */
const decodeMemberInList = (rawMembers, { memberId, connId }) => {
  const memberNum = rawMembers
    .map((_) => _.S)
    .findIndex(
      (_) => (memberId
        ? _.startsWith(memberId + SEP)
        : _.endsWith(SEP + connId)),
    );
  if (memberNum === -1) return { memberNum };

  return {
    memberNum,
    ...decodeMemberNConnId(rawMembers[memberNum].S),
  };
};

const encodeMember = ({ memberId, connId }) => ({ S: `${memberId}${SEP}${connId || ''}` });

const encodeMemberList = (members) => members.map(encodeMember);

const setConn = (connId, sessionKey) => DDB.putItem({
  TableName: CONNECTION_TABLE_NAME,
  Item: {
    id: { S: connId },
    sessionKey: { M: sessionKey },
  },
}).promise();

const del = (table, key, extras = {}) => DDB.deleteItem({
  TableName: table,
  Key: key,
  ...extras,
}).promise();

const delConn = (connId, extras = {}) => del(CONNECTION_TABLE_NAME, { id: { S: connId } }, extras);

const getSession = (sessionKey, extras = {}) => DDB.getItem({
  TableName: SESSION_TABLE_NAME,
  Key: sessionKey,
  ...extras,
}).promise();

const updateSessionMembers = (sessionKey, rawMembers, lastMembersChangeNum) => DDB.updateItem({
  TableName: SESSION_TABLE_NAME,
  Key: sessionKey,
  UpdateExpression: `
      SET members = :members
      ADD membersChangeNum :one
    `,
  ExpressionAttributeValues: {
    ':one': { N: '1' },
    ':members': { L: rawMembers },
    ':lastMembersChangeNum': { N: lastMembersChangeNum.toString() },
  },
  ConditionExpression: 'membersChangeNum = :lastMembersChangeNum',
}).promise();

const delSession = (sessionKey, extras = {}) => del(SESSION_TABLE_NAME, sessionKey, extras);

const communicate = async (connId, payload) => {
  try {
    await APIGW.postToConnection({
      ConnectionId: connId,
      Data: JSON.stringify(payload),
    }).promise();
  } catch (e) {
    if (e.statusCode === 410) await delConn(connId);
    else throw e;
  }
};

const commToAllMembers = (members, payload) => Promise.all(
  members
    .filter((_) => _.connId)
    .map(({ connId }) => communicate(connId, payload)),
);

const joinSession = async (event) => {
  const qs = event.queryStringParameters;
  const connId = event.requestContext.connectionId;

  // Validate input
  // `?sessionType=<string>[&targetNumMembers=<num>][&private=true][&sessionId=<string>]`
  //
  // - `targetNumMembers` must and can only be provided if `id` is not
  // - `targetNumMembers`, when provided, must be > 1
  // - `private` and `id` are mutually exclusive
  if (!(
    qs.sessionType
    && (
      (
        !Number.isNaN(parseInt(qs.targetNumMembers, 10))
        && typeof qs.sessionId === 'undefined'
      )
      || (
        typeof qs.targetNumMembers === 'undefined'
        && qs.sessionId
      )
    )
    && (typeof qs.private === 'undefined' || typeof qs.sessionId === 'undefined')
    && (typeof qs.sessionId === 'undefined' || typeof qs.private === 'undefined')
  )) return error();

  // Extract input
  let targetNumMembers = parseInt(qs.targetNumMembers, 10);
  if (targetNumMembers <= 1) return error();

  const hostingPrivate = !!qs.private;
  const joiningPrivate = !!qs.sessionId;
  const pblc = !hostingPrivate && !joiningPrivate;
  const standardId = newId();
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
  let sessionAlreadyExists = joiningPrivate;
  let curRawMembers = [];

  // If public, check if there's an open session
  if (pblc) {
    openSession = await getSession(openSessionKey, { ConsistentRead: true });

    if (openSession.Item) sessionAlreadyExists = true;
    else openSession = undefined;
  }

  // Set the destination session's ID
  // (skipping if `qs.sessionId` is provided because that'll use a `begins-with` condition)
  sessionKey.id = openSession
    ? openSession.Item.openSessionId
    : { S: qs.sessionId ? qs.sessionId : standardId };

  // If there's an open or private session to join, get its current details
  if (sessionAlreadyExists) {
    const cur = await getSession(sessionKey, { ConsistentRead: true });

    if (!cur.Item) {
      // If there's an orphaned open session then delete it manually,
      // because it won't be able to play well with automated expiration
      if (openSession) await delSession(openSessionKey);
      return error();
    }

    targetNumMembers = parseInt(cur.Item.targetNumMembers.N, 10);
    sessionKey.id = cur.Item.id;
    lastMembersChangeNum = parseInt(cur.Item.membersChangeNum.N, 10);
    curRawMembers = cur.Item.members.L;
    if (curRawMembers.length >= targetNumMembers) return error();
  }

  // Add ourselves to the member list
  const newRawMembers = [...curRawMembers];
  newRawMembers.push({ S: memberId + SEP + connId });

  // TODO: Run the updates below in a single transaction (for speed)

  // Create or update with the new session details
  if (!sessionAlreadyExists) {
    // Create new session
    await (DDB.putItem({
      TableName: SESSION_TABLE_NAME,
      Item: {
        ...sessionKey,
        members: { L: newRawMembers },
        membersChangeNum: { N: '0' },
        targetNumMembers: { N: targetNumMembers.toString() },
        ...(hostingPrivate ? { isPrivate: { BOOL: true } } : {}),
      },
      ConditionExpression: 'attribute_not_exists(#type)',
      ExpressionAttributeNames: { '#type': 'type' },
    }).promise());
  } else {
    // Update session members
    await updateSessionMembers(sessionKey, newRawMembers, lastMembersChangeNum);
  }

  // If it's a new public session, create open session link
  if (pblc && !sessionAlreadyExists) {
    await (DDB.putItem({
      TableName: SESSION_TABLE_NAME,
      Item: {
        ...sessionKey,
        id: openSessionKey.id,
        openSessionId: sessionKey.id,
      },
      ConditionExpression: 'attribute_not_exists(id)',
    }).promise());
  }

  // Record connection to the session
  await setConn(connId, sessionKey);

  // If the session is full...
  if (newRawMembers.length === targetNumMembers) {
    // Destroy open session link
    if (openSession) await delSession(openSessionKey);

    // Members are notified of session start via `sessionMembersChangedHandler`
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

  const session = await getSession(sessionKey);

  if (!session.Item) return error();
  const lastMembersChangeNum = parseInt(session.Item.membersChangeNum.N, 10);
  const rawMembers = session.Item.members.L;

  const {
    memberNum,
    connId: oldConnId,
  } = decodeMemberInList(rawMembers, { memberId: qs.memberId });

  if (typeof memberNum === 'undefined') return error();
  const memberNConnId = qs.memberId + SEP + connId;
  rawMembers[memberNum] = { S: memberNConnId };

  await Promise.all([
    updateSessionMembers(sessionKey, rawMembers, lastMembersChangeNum),
    setConn(connId, sessionKey),
    ...(oldConnId
      ? [
        delConn(oldConnId),
        communicate(oldConnId, { type: 'CONNECTION_OVERWRITE' }),
      ]
      : []
    ),
  ]);

  return success;
};

const connect = (event) => {
  const qs = event.queryStringParameters;
  if (!qs) return error();

  if (typeof qs.memberId !== 'undefined') return rejoinSession(event);
  return joinSession(event);
};

const disconnect = async (event) => {
  const connId = event.requestContext.connectionId;

  // Delete connection, returning original session key
  const conn = await delConn(connId, { ReturnValues: 'ALL_OLD' });
  if (!conn.Attributes) return success;

  // Get session
  const sessionKey = conn.Attributes.sessionKey.M;
  const session = await getSession(sessionKey);
  if (!session.Item) return success;

  let started = false;
  const promises = [];

  // Find this member within the session
  const rawMembers = session.Item.members.L;
  const { memberNum } = decodeMemberInList(rawMembers, { connId });

  const newMembers = decodeMemberList(rawMembers);

  if (memberNum !== -1) {
    const id = session.Item.id.S;
    const targetNumMembers = parseInt(session.Item.targetNumMembers.N, 10);
    const isPrivate = id.split(SEP).length === 3;

    started = newMembers.length >= targetNumMembers;

    // Completely remove member from the session if it's still open
    if (!started) newMembers.splice(memberNum, 1);
    // Otherwise just clear connection ID to let them reconnect
    else delete newMembers[memberNum].connId;

    // If the session is now empty...
    if (newMembers.length === 0) {
      // delete it...
      promises.push(delSession(sessionKey));

      if (!started && !isPrivate) {
      // and the open session record that points to it
        promises.push(delSession({
          ...sessionKey,
          id: { S: OPEN_SESSION_ID + SEP + targetNumMembers.toString() },
        }));
      }
    } else {
      // Otherwise update the session
      const lastMembersChangeNum = parseInt(session.Item.membersChangeNum.N, 10);
      await updateSessionMembers(sessionKey, encodeMemberList(newMembers), lastMembersChangeNum);
    }
  }

  await Promise.all(promises);

  // If the session's started, tell its members that someone's disconnected
  if (started) {
    await commToAllMembers(
      newMembers,
      {
        type: 'MEMBER_DISCONNECT',
        memberNum,
      },
    );
  }

  return success;
};

/**
 * `event.body = { action: "endSession" }`
 */
const endSession = async (conn) => {
  const session = await delSession(conn.Item.sessionKey.M, { ReturnValues: 'ALL_OLD' });

  if (!session.Attributes) {
    await communicate(conn.Item.id.S, { type: 'INVALID_CONNECTION' });
    return error();
  }

  const members = decodeMemberList(session.Attributes.members.L);

  const comms = commToAllMembers(members, { type: 'SESSION_END' });

  const delConns = DDB.batchWriteItem({
    RequestItems: {
      [CONNECTION_TABLE_NAME]: members
        .filter((_) => _.connId)
        .map(({ connId }) => ({ DeleteRequest: { Key: { id: { S: connId } } } })),
    },
  }).promise();

  await Promise.all([comms, delConns]);

  return success;
};

/**
 * `event.body = { action: "heartbeat"[, inclMessagesAfter: <int>] }`
 */
const heartbeat = async (conn, session, body) => {
  if (typeof body.inclMessagesAfter === 'undefined') return success;

  // TODO

  return success;
};

/**
 * `event.body = { action: "sendMessage", payload: <string>[, pinned: <bool>] }`
 */
const sendMessage = async (conn, session, body) => {
  if (!(body && typeof body.payload === 'string')) return error();

  const now = Date.now();

  if (body.pinned) {
    await (DDB.updateItem({
      TableName: SESSION_TABLE_NAME,
      Key: conn.Item.sessionKey.M,
      ConditionExpression: 'attribute_not_exists(pinTime) OR pinTime < :pinTime',
      UpdateExpression: 'set pinnedMessage = :payload, pinTime = :pinTime',
      ExpressionAttributeValues: {
        ':payload': { S: body.payload },
        ':pinTime': { N: now.toString() },
      },
    }).promise());
  }

  const rawMembers = session.Item.members.L;
  const { memberNum } = decodeMemberInList(rawMembers, { connId: conn.Item.id.S });

  await commToAllMembers(
    decodeMemberList(rawMembers),
    {
      type: 'MESSAGE',
      memberNum,
      time: now,
      payload: body.payload,
      ...(body.pinned ? { pinned: true } : {}),
    },
  );

  return success;
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

  const session = await getSession(conn.Item.sessionKey.M);
  if (!session.Item) {
    await communicate(connId, { type: 'INVALID_CONNECTION' });
    return success;
  }

  return fns[action](conn, session, body);
};

/**
```
event = { Records: [ {
  OldImage: <item>, // Does not exist if new
  NewImage: <item>, // Does not exist if deleted
} ] }
```

Do not change the session in this handler, to avoid trigger loops

This lambda performs the following tasks when appropriate:
- Notify new private session members of session details
  (because they can join without knowing them)
- Notify members that the session has started
- Notify members of reconnection
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

  const targetNumMembers = parseInt(session.targetNumMembers.N, 10);
  const oldRawMembers = changes.OldImage ? changes.OldImage.members.L : [];
  const newRawMembers = session.members.L;
  const membersChanged = JSON.stringify(oldRawMembers) !== JSON.stringify(newRawMembers);
  const sessionStarted = newRawMembers.length === targetNumMembers;
  const sessionJustStarted = sessionStarted && oldRawMembers.length !== targetNumMembers;

  if (!membersChanged) return success;

  const oldMembers = decodeMemberList(oldRawMembers);
  const newMembers = decodeMemberList(newRawMembers);

  // Notify new private session members of session details
  if (
    newMembers.length === oldMembers.length + 1
    && newMembers.length !== targetNumMembers
    && session.isPrivate.BOOL
  ) {
    await communicate(
      newMembers[newMembers.length - 1].connId,
      {
        type: 'PRIVATE_SESSION_PENDING',
        sessionId: session.id.S,
        targetNumMembers,
      },
    );
  }

  // Notify members that the session has started
  if (sessionJustStarted) {
    await Promise.all(
      newMembers.map(({ memberNum, memberId, connId }) => communicate(
        connId,
        {
          type: 'SESSION_START',
          sessionType: session.type.S,
          sessionId: session.id.S,
          memberNum,
          memberId,
          numMembers: newMembers.length,
        },
      )),
    );
  }

  const connectedMembers = newMembers.filter(({ connId }) => connId);
  const connectedMembersFlags = newMembers.map((_) => !!_.connId);

  if (newMembers.length === oldMembers.length) {
    const reconnectedMembers = newMembers.filter(
      ({ memberNum, connId }) => connId && !oldMembers[memberNum].connId,
    );

    // Notify members of reconnection
    if (reconnectedMembers.length !== 0) {
      await Promise.all(
        reconnectedMembers.map(({ memberNum, connId }) => Promise.all(connectedMembers.map((
          ({ connId: iConnId }) => communicate(
            iConnId,
            connId === iConnId
              ? {
                type: 'SESSION_RECONNECT',
                memberNum,
                ...(
                  session.pinnedMessage
                    ? {
                      pinnedMessage: session.pinnedMessage.S,
                      pinTime: session.pinTime.N,
                    }
                    : {}
                ),
                members: connectedMembersFlags,
              }
              : {
                type: 'MEMBER_RECONNECT',
                memberNum,
              },
          )
        )))),
      );
    }
  }

  return success;
};
