const shortid = require('shortid');
const AWS = require('aws-sdk');

shortid.characters('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_');

const DDB = new AWS.DynamoDB({ apiVersion: '2012-10-08' });
let APIGW;

const {
  CONNECTION_TABLE_NAME,
  SESSION_TABLE_NAME,
  APIGW_ENDPOINT, // Not set/needed in `webSocketHandler`
} = process.env;

// Not set/needed in `sessionMembersChangedHandler`
const CONNECTION_EXPIRE_AFTER_SECONDS = parseInt(process.env.CONNECTION_EXPIRE_AFTER_SECONDS, 10);
// Not set/needed in `sessionMembersChangedHandler`
const SESSION_EXPIRE_AFTER_SECONDS = parseInt(process.env.SESSION_EXPIRE_AFTER_SECONDS, 10);

const SEP = '.'; // '.' is not included in `shortid` or AWS IDs, and is query string safe
const OPEN_SESSION_ID = `${SEP}open`;

const success = { statusCode: 200 };
const error = () => { // TODO: Understand the different kinds of error handling
  throw new Error();
  return { statusCode: 500 };
};

const newId = () => shortid.generate();

const getOpenSessionId = (type, targetNumMembers) => (
  OPEN_SESSION_ID + SEP + type + SEP + targetNumMembers.toString()
);

const getExpirationTime = (afterSeconds) => Date.now() + afterSeconds * 1000;

const getMember = (rawMemberList, { memberId, connId }) => {
  const memberNum = rawMemberList.findIndex(
    (_) => (memberId
      ? _.M.memberId.S === memberId
      : _.M.connId && _.M.connId.S === connId
    ),
  );

  if (memberNum === -1) return { memberNum };

  const rawMember = rawMemberList[memberNum];

  return {
    memberNum,
    memberId: rawMember.M.memberId.S,
    ...(rawMember.M.connId ? { connId: rawMember.M.connId.S } : {}),
  };
};

const del = (table, key, extras = {}) => DDB.deleteItem({
  TableName: table,
  Key: key,
  ...extras,
}).promise();

const updateConnExpiration = (connId) => DDB.updateItem({
  TableName: CONNECTION_TABLE_NAME,
  Key: { id: { S: connId } },
  UpdateExpression: 'SET expireAfter = :expireAfter',
  ExpressionAttributeValues: {
    ':expireAfter': { N: getExpirationTime(CONNECTION_EXPIRE_AFTER_SECONDS).toString() },
  },
  ConditionExpression: 'attribute_exists(id)',
  ReturnValues: 'ALL_OLD',
}).promise();

const delConn = (connId, extras = {}) => del(CONNECTION_TABLE_NAME, { id: { S: connId } }, extras);

const getSession = (id, extras = {}) => DDB.getItem({
  TableName: SESSION_TABLE_NAME,
  Key: { id: { S: id } },
  ...extras,
}).promise();

const delSession = (id, extras = {}) => del(SESSION_TABLE_NAME, { id: { S: id } }, extras);

const communicate = async (connId, payload) => {
  try {
    await APIGW.postToConnection({
      ConnectionId: connId,
      Data: JSON.stringify(Array.isArray(payload) ? payload : [payload]),
    }).promise();
  } catch (e) {
    if (e.statusCode === 410) await delConn(connId);
    else throw e;
  }
};

const commToAllMembers = (rawMembers, payload) => Promise.all(
  rawMembers
    .filter((_) => _.M.connId)
    .map((_) => communicate(_.M.connId.S, payload)),
);

const joinSession = async (event) => {
  const qs = event.queryStringParameters;
  const connId = event.requestContext.connectionId;

  // Validate input
  // `?sessionType=<string>[&targetNumMembers=<num>][&private=true][&sessionId=<string>]`
  //
  // - `targetNumMembers` must and can only be provided if `sessionId` is not
  // - `targetNumMembers`, when provided, must be > 1
  // - `private` and `sessionId` are mutually exclusive
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
  const targetNumMembers = parseInt(qs.targetNumMembers, 10);
  if (targetNumMembers <= 1) return error();

  const hostingPrivate = !!qs.private;
  const joiningPrivate = !!qs.sessionId;
  const pblc = !hostingPrivate && !joiningPrivate;
  let isNewPublic = false;

  let sessionId = joiningPrivate ? qs.sessionId : newId();
  const memberId = newId();
  const openSessionId = getOpenSessionId(qs.sessionType, targetNumMembers);

  const newMember = { M: { memberId: { S: memberId }, connId: { S: connId } } };
  const expireAfter = { N: getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS).toString() };

  // If public, check if there's an open session
  if (pblc) {
    const openSession = await getSession(openSessionId);
    if (openSession.Item) sessionId = openSession.Item.openSessionId.S;
    else isNewPublic = true;
  }

  const isNew = isNewPublic || hostingPrivate;

  await (DDB.transactWriteItems({
    TransactItems: [
      {
        Put: {
          TableName: CONNECTION_TABLE_NAME,
          Item: {
            id: { S: connId },
            sessionId: { S: sessionId },
            expireAfter,
          },
        },
      },
      {
        Update: {
          TableName: SESSION_TABLE_NAME,
          Key: { id: { S: sessionId } },
          UpdateExpression: `
            SET members = list_append(if_not_exists(members, :emptyList), :newMember),
              expireAfter = :expireAfter
              ${isNew ? `, targetNumMembers = :targetNumMembers, #type = :type
                ${hostingPrivate ? ', isPrivate = :true' : ''}
              ` : ''}
          `,
          ConditionExpression: `
            (attribute_not_exists(members) OR size(members) < targetNumMembers)
            ${!isNew ? ' AND attribute_exists(id)' : ''}
          `,
          ExpressionAttributeValues: {
            ':emptyList': { L: [] },
            ':newMember': { L: [newMember] },
            ':expireAfter': expireAfter,
            ...(isNew ? {
              ':targetNumMembers': { N: targetNumMembers.toString() },
              ':type': { S: qs.sessionType },
              ...(hostingPrivate ? { ':true': { BOOL: true } } : {}),
            } : {}),
          },
          ...(isNew ? { ExpressionAttributeNames: { '#type': 'type' } } : {}),
        },
      },
      {
        Put: {
          TableName: SESSION_TABLE_NAME,
          Item: {
            id: { S: openSessionId },
            openSessionId: { S: sessionId },
            expireAfter,
          },
          ConditionExpression: 'attribute_not_exists(id) OR openSessionId = :sessionId',
          ExpressionAttributeValues: { ':sessionId': { S: sessionId } },
        },
      },
    ],
  }).promise());

  // Members are notified of session start via `sessionMembersChangedHandler`
  // Open sessions for full sessions are deleted via `sessionMembersChangedHandler`

  return success;
};

const rejoinSession = async (event) => {
  const qs = event.queryStringParameters;
  const connId = event.requestContext.connectionId;

  // Validate input
  // `?sessionId=<string>&memberId=<string>`
  if (!(qs.sessionId && qs.memberId)) return error();

  const session = await getSession(qs.sessionId);

  if (!session.Item) return error();
  const rawMembers = session.Item.members.L;

  const {
    memberNum,
    connId: oldConnId,
  } = getMember(rawMembers, { memberId: qs.memberId });

  if (memberNum === -1) return error();
  const newMember = { M: { memberId: { S: qs.memberId }, connId: { S: connId } } };
  const expireAfter = { N: getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS).toString() };

  await Promise.all([
    DDB.transactWriteItems({
      TransactItems: [
        {
          Put: {
            TableName: CONNECTION_TABLE_NAME,
            Item: {
              id: { S: connId },
              sessionId: { S: qs.sessionId },
              expireAfter,
            },
          },
        },
        {
          Update: {
            TableName: SESSION_TABLE_NAME,
            Key: { id: { S: qs.sessionId } },
            UpdateExpression: `
              SET members[${memberNum}] = :newMember,
                expireAfter = :expireAfter
            `,
            ExpressionAttributeValues: {
              ':newMember': newMember,
              ':expireAfter': expireAfter,
            },
          },
        },
        ...(oldConnId ? [{
          Delete: {
            TableName: CONNECTION_TABLE_NAME,
            Key: { id: { S: oldConnId } },
          },
        }] : []),
      ],
    }).promise(),
    ...(oldConnId ? [communicate(oldConnId, { type: 'CONNECTION_OVERWRITE' })] : []),
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

  const sessionId = conn.Attributes.sessionId.S;
  const session = await getSession(sessionId);
  if (!session.Item) return success;

  const priv = session.Item.isPrivate && session.Item.isPrivate.BOOL;
  const targetNumMembers = parseInt(session.Item.targetNumMembers.N, 10);
  const rawMembers = session.Item.members.L;
  const started = rawMembers.length >= targetNumMembers;

  const { memberId, memberNum } = getMember(rawMembers, { connId });
  if (memberNum === -1) return success;

  // If the game's not started and we're the only person in it...
  if (!started && rawMembers.length === 1) {
    await Promise.all([
    // ... then delete the session
      delSession(sessionId),

      ...(!priv ? [ // ... and the open session (if it's public)
        delSession(getOpenSessionId(session.Item.type.S, targetNumMembers)),
      ] : []),
    ]);
  } else { // Otherwise...
    // ... update the session member list
    await DDB.updateItem({
      TableName: SESSION_TABLE_NAME,
      Key: { id: { S: sessionId } },
      UpdateExpression: started
        ? `REMOVE members[${memberNum}].connId`
        : `REMOVE members[${memberNum}]`,
      ...(!started ? {
        ConditionExpression: `
          size(members) < targetNumMembers
          AND members[${memberNum}].memberId = :memberId
        `,
        ExpressionAttributeValues: {
          ':memberId': { S: memberId },
        },
      } : {}),
    }).promise();

    if (started) { // ... and notify other members if the session has started
      const commMembers = [...rawMembers];
      delete commMembers[memberNum].M.connId;

      await commToAllMembers(
        commMembers,
        {
          type: 'MEMBER_DISCONNECT',
          memberNum,
        },
      );
    }
  }

  return success;
};

/**
 * `event.body = { action: "END_SESSION" }`
 */
const endSession = async (connId) => {
  const conn = await (DDB.getItem({
    TableName: CONNECTION_TABLE_NAME,
    Key: { id: { S: connId } },
  }).promise());

  const session = await delSession(conn.Item.sessionId.S, { ReturnValues: 'ALL_OLD' });

  if (!session.Attributes) {
    await communicate(conn.Item.id.S, { type: 'INVALID_CONNECTION' });
    return error();
  }

  const comms = commToAllMembers(session.Attributes.members.L, { type: 'SESSION_END' });

  const delConns = DDB.batchWriteItem({
    RequestItems: {
      [CONNECTION_TABLE_NAME]: session.Attributes.members.L
        .filter((_) => _.M.connId)
        .map((_) => ({ DeleteRequest: { Key: { id: { S: _.M.connId.S } } } })),
    },
  }).promise();

  await Promise.all([comms, delConns]);

  return success;
};

/**
 * `event.body = { action: "HEARTBEAT"[, inclMessagesAfter: <int>] }`
 */
const heartbeat = async (conn, body) => {
  const session = await (DDB.updateItem({
    TableName: SESSION_TABLE_NAME,
    Key: { id: { S: conn.Attributes.sessionId.S } },
    UpdateExpression: 'SET expireAfter = :expireAfter',
    ExpressionAttributeValues: {
      ':expireAfter': { N: getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS).toString() },
    },
    ReturnValues: 'ALL_OLD',
  }).promise());

  const inclMessagesAfter = parseInt(body.inclMessagesAfter, 10);

  const messages = [{ type: 'HEARTBEAT' }];

  if (!(
    Number.isNaN(inclMessagesAfter)
    || !session.Attributes || !session.Attributes.pinnedMessage
    || session.Attributes.pinnedMessage.M.time.N <= inclMessagesAfter
  )) {
    const pinned = session.Attributes.pinnedMessage.M;

    messages.push({
      type: 'MESSAGE',
      payload: pinned.payload.S,
      time: pinned.time.N,
      memberNum: pinned.memberNum.N,
      pinned: true,
    });
  }

  await communicate(conn.Attributes.id.S, messages);

  return success;
};

/**
 * `event.body = { action: "SEND_MESSAGE", payload: <string>[, pinned: <bool>] }`
 */
const sendMessage = async (conn, body) => {
  if (!(body && typeof body.payload === 'string')) return error();

  const now = Date.now();

  const session = await getSession(conn.Attributes.sessionId.S);
  if (!session) return error();

  const rawMembers = session.Item.members.L;
  const { memberNum } = getMember(rawMembers, { connId: conn.Attributes.id.S });

  await (DDB.updateItem({
    TableName: SESSION_TABLE_NAME,
    Key: { id: { S: conn.Attributes.sessionId.S } },
    UpdateExpression: `
      SET expireAfter = :expireAfter
        ${body.pinned ? ', pinnedMessage = :pinnedMessage' : ''}
    `,
    ExpressionAttributeValues: {
      ':expireAfter': { N: getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS).toString() },
      ...(body.pinned ? {
        ':pinnedMessage': {
          M: {
            payload: { S: body.payload },
            time: { N: now.toString() },
            memberNum: { N: memberNum.toString() },
          },
        },
      } : {}),
    },
  }).promise());

  await commToAllMembers(
    rawMembers,
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

  const connId = event.requestContext.connectionId;

  if (body.action === 'END_SESSION') return endSession(connId);

  const actions = ['HEARTBEAT', 'SEND_MESSAGE'];
  const fns = [heartbeat, sendMessage];
  const action = actions.indexOf(body.action);
  if (action === -1) return error();

  const conn = await updateConnExpiration(connId);

  if (!conn.Attributes) {
    await communicate(connId, { type: 'INVALID_CONNECTION' });
    return success;
  }

  return fns[action](conn, body);
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
    - and delete open session if public
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
  const priv = session.isPrivate && session.isPrivate.BOOL;

  if (!membersChanged) return success;

  // Notify new private session members of session details
  if (
    newRawMembers.length === oldRawMembers.length + 1
    && newRawMembers.length !== targetNumMembers
    && priv
  ) {
    await communicate(
      newRawMembers[newRawMembers.length - 1].M.connId.S,
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
      newRawMembers.map((_, i) => communicate(
        _.M.connId.S,
        {
          type: 'SESSION_START',
          sessionType: session.type.S,
          sessionId: session.id.S,
          memberNum: i,
          memberId: _.M.memberId.S,
          numMembers: newRawMembers.length,
        },
      )),

      // ... and delete open session if public
      ...(!priv ? [delSession(getOpenSessionId(
        session.type.S,
        session.targetNumMembers.N,
      ))] : []),
    );
  }

  const connectedRawMembers = newRawMembers.filter((_) => _.M.connId);
  const connectedRawMembersFlags = newRawMembers.map((_) => !!_.M.connId);

  if (newRawMembers.length === oldRawMembers.length) {
    const reconnectedMembers = newRawMembers
      .filter((_, i) => {
        const thisConnS = _.M.connId && _.M.connId.S;
        const thatConn = oldRawMembers[i].M.connId;

        return thisConnS && (!thatConn || thisConnS !== thatConn.S);
      })
      .map((_) => getMember(newRawMembers, { memberId: _.M.memberId.S }));

    // Notify members of reconnection
    if (reconnectedMembers.length !== 0) {
      await Promise.all(
        reconnectedMembers.map((rm) => Promise.all(connectedRawMembers.map((
          (cm) => communicate(
            cm.M.connId.S,
            rm.connId === cm.M.connId.S
              ? {
                type: 'SESSION_RECONNECT',
                memberNum: rm.memberNum,
                ...(session.pinnedMessage ? {
                  pinnedMessage: {
                    payload: session.pinnedMessage.M.payload.S,
                    time: session.pinnedMessage.M.time.N,
                    memberNum: session.pinnedMessage.M.memberNum.N,
                    pinned: true,
                  },
                } : {}),
                members: connectedRawMembersFlags,
              }
              : {
                type: 'MEMBER_RECONNECT',
                memberNum: rm.memberNum,
              },
          )
        )))),
      );
    }
  }

  return success;
};
