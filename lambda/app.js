const shortid = require('shortid');
const AWS = require('aws-sdk');

shortid.characters('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_');

const {
  MEMBER_TABLE_NAME,
  CONNECTION_TABLE_NAME,
  SESSION_TABLE_NAME,
  WS_APIGW_ENDPOINT, // Not present on WebSocketLambda
} = process.env;

const DDB = new AWS.DynamoDB({ apiVersion: '2012-10-08' });

let APIGW;
const setUpAPIGW = (endpoint) => {
  APIGW = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint,
  });
};

// Not set/needed in `sessionMembersChangedHandler`
const CONNECTION_EXPIRE_AFTER_SECONDS = parseInt(process.env.CONNECTION_EXPIRE_AFTER_SECONDS, 10);
// Not set/needed in `sessionMembersChangedHandler`
const SESSION_EXPIRE_AFTER_SECONDS = parseInt(process.env.SESSION_EXPIRE_AFTER_SECONDS, 10);

const SEP = '.'; // '.' is not included in `shortid` or AWS IDs, and is query string safe
const OPEN_SESSION_ID = `${SEP}open`;

const success = { statusCode: 200 };

// TODO: Make it soft
const softError = () => {
  throw new Error();
  return { statusCode: 500 }; // eslint-disable-line
};
// TODO: Make it retry
const retryError = () => {
  throw new Error();
  return { statusCode: 500 }; // eslint-disable-line
};

const newId = () => shortid.generate();

const getOpenSessionId = (type, targetNumMembers) => (
  OPEN_SESSION_ID + SEP + type + SEP + targetNumMembers.toString()
);

const getExpirationTime = (afterSeconds) => ({
  N: (Math.floor(Date.now() / 1000) + afterSeconds).toString(),
});

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

const getMemberRecord = (memberId, sessionId, connId) => ({
  TableName: MEMBER_TABLE_NAME,
  Item: {
    id: { S: memberId },
    sessionId: { S: sessionId },
    connId: { S: connId },
    expireAfter: getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS),
  },
});
const updateMemberRecord = (memberId, sessionId, connId) => DDB.putItem(
  getMemberRecord(memberId, sessionId, connId),
).promise();

const transactWriteItems = (params) => {
  const trans = DDB.transactWriteItems(params);
  let cancellationReasons = null;

  trans.on('extractError', (res) => {
    try {
      cancellationReasons = JSON.parse(res.httpResponse.body.toString()).CancellationReasons;
    } catch (e) {} // eslint-disable-line no-empty
  });

  return new Promise((resolve, reject) => {
    trans.send((err, res) => {
      if (err) {
        if (cancellationReasons !== null) {
          err.cancellationReasons = cancellationReasons; // eslint-disable-line no-param-reassign
        }
        return reject(err);
      }
      return resolve(res);
    });
  });
};

const del = (table, key, extras = {}) => DDB.deleteItem({
  TableName: table,
  Key: key,
  ...extras,
}).promise();

const updateConnExpiration = async (connId) => {
  let conn;
  try {
    conn = await DDB.updateItem({
      TableName: CONNECTION_TABLE_NAME,
      Key: { id: { S: connId } },
      UpdateExpression: 'SET expireAfter = :expireAfter',
      ExpressionAttributeValues: {
        ':expireAfter': getExpirationTime(CONNECTION_EXPIRE_AFTER_SECONDS),
      },
      ConditionExpression: 'attribute_exists(id)',
      ReturnValues: 'ALL_OLD',
    }).promise();
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') return null;
    throw e;
  }

  if (!conn.Attributes) conn = null;
  return conn;
};

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

const sendInvalidConnection = (connId) => communicate(connId, { type: 'INVALID_CONNECTION' });

const getMessageMessage = (payload, time, memberNum, pinned) => ({
  type: 'MESSAGE',
  payload,
  time,
  memberNum,
  ...(pinned ? { pinned } : {}),
});

const getMessagePrivateSessionPending = (sessionId, targetNumMembers) => ({
  type: 'PRIVATE_SESSION_PENDING',
  sessionId,
  targetNumMembers,
});

const getMessageSessionStart = (sessionType, sessionId, memberNum, numMembers) => ({
  type: 'SESSION_START',
  sessionType,
  sessionId,
  memberNum,
  numMembers,
});

const getMessageSessionReconnect = (rawMembers, memberNum, rawPinnedMessage) => ({
  type: 'SESSION_RECONNECT',
  members: rawMembers.map((_) => !!_.M.connId),
  memberNum,
  ...(rawPinnedMessage ? {
    pinnedMessage: {
      payload: rawPinnedMessage.payload.S,
      time: rawPinnedMessage.time.N,
      memberNum: rawPinnedMessage.memberNum.N,
      pinned: true,
    },
  } : {}),
});

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
  )) return softError();

  // Extract input
  const targetNumMembers = parseInt(qs.targetNumMembers, 10);
  if (targetNumMembers <= 1) return softError(); // NaN passes through

  const hostingPrivate = !!qs.private;
  const joiningPrivate = !!qs.sessionId;
  const pblc = !hostingPrivate && !joiningPrivate;

  let sessionId = joiningPrivate ? qs.sessionId : newId();
  const memberId = newId();

  const newMember = { M: { memberId: { S: memberId }, connId: { S: connId } } };
  const expireAfter = getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS);

  let newNumWaiting = 1;
  const openSessionId = getOpenSessionId(qs.sessionType, targetNumMembers);
  // If public, check if there's an open session
  if (pblc) {
    const openSession = await getSession(openSessionId);
    if (openSession.Item) {
      sessionId = openSession.Item.openSessionId.S;
      newNumWaiting = parseInt(openSession.Item.numWaiting.N, 10) + 1;
    }
  }

  const isNew = (pblc && newNumWaiting === 1) || hostingPrivate;

  try {
    await transactWriteItems({
      TransactItems: [
        { Put: { ...getMemberRecord(memberId, sessionId, connId) } },
        {
          Put: {
            TableName: CONNECTION_TABLE_NAME,
            Item: {
              id: { S: connId },
              sessionId: { S: sessionId },
              expireAfter: getExpirationTime(CONNECTION_EXPIRE_AFTER_SECONDS),
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
                ':type': { S: qs.sessionType },
                ':targetNumMembers': { N: targetNumMembers.toString() },
                ...(hostingPrivate ? { ':true': { BOOL: true } } : {}),
              } : {}),
            },
            ...(isNew ? { ExpressionAttributeNames: { '#type': 'type' } } : {}),
          },
        },
        ...(pblc ? ( // eslint-disable-line no-nested-ternary
          newNumWaiting !== targetNumMembers
            ? [{
              Update: {
                TableName: SESSION_TABLE_NAME,
                Key: { id: { S: openSessionId } },
                UpdateExpression: `
                  SET openSessionId = :sessionId,
                    expireAfter = :expireAfter
                  ADD numWaiting :one
                `,
                ConditionExpression: `
                  attribute_not_exists(id)
                  OR (
                    openSessionId = :sessionId
                    AND numWaiting < :targetNumMembersMinus1
                  )
                `,
                ExpressionAttributeValues: {
                  ':sessionId': { S: sessionId },
                  ':expireAfter': expireAfter,
                  ':targetNumMembersMinus1': { N: (targetNumMembers - 1).toString() },
                  ':one': { N: '1' },
                },
              },
            }]
            : [{
              Delete: {
                TableName: SESSION_TABLE_NAME,
                Key: { id: { S: openSessionId } },
                ConditionExpression: 'numWaiting = :targetNumMembersMinus1',
                ExpressionAttributeValues: {
                  ':targetNumMembersMinus1': { N: (targetNumMembers - 1).toString() },
                },
              },
            }]
        ) : []),
      ],
    });
  } catch (e) {
    if (e.code === 'TransactionCanceledException') {
      if (e.cancellationReasons[2].Code === 'ConditionalCheckFailed') return softError();
      if (
        e.cancellationReasons[3]
        && e.cancellationReasons[3].Code === 'ConditionalCheckFailed'
      ) return retryError();
    }
    throw e;
  }

  // Members are notified of session start via `sessionMembersChangedHandler`

  return success;
};

const rejoinSession = async (event) => {
  const qs = event.queryStringParameters;
  const connId = event.requestContext.connectionId;

  // Validate input
  // `?memberId=<string>`
  if (!qs.memberId) return softError();

  const memberRecord = (await (DDB.getItem({
    TableName: MEMBER_TABLE_NAME,
    Key: { id: { S: qs.memberId } },
  }).promise())).Item;

  if (!memberRecord) return softError();

  const sessionId = memberRecord.sessionId.S;
  const session = await getSession(sessionId);

  if (!session.Item) return softError();
  const rawMembers = session.Item.members.L;

  const {
    memberNum,
    connId: oldConnId,
  } = getMember(rawMembers, { memberId: qs.memberId });

  if (memberNum === -1) return softError();
  const newMember = { M: { memberId: { S: qs.memberId }, connId: { S: connId } } };
  const expireAfter = getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS);

  const transaction = transactWriteItems({
    TransactItems: [
      { Put: { ...getMemberRecord(qs.memberId, sessionId, connId) } },
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
            SET members[${memberNum}] = :newMember,
              expireAfter = :expireAfter
          `,
          ConditionExpression: `members[${memberNum}].memberId = :memberId`,
          ExpressionAttributeValues: {
            ':memberId': { S: qs.memberId },
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
  }).catch((e) => {
    if (
      e.code === 'TransactionCanceledException'
      && e.cancellationReasons[2].Code === 'ConditionalCheckFailed'
    ) return retryError();
    throw e;
  });

  await Promise.all([
    transaction,
    ...(oldConnId ? [communicate(oldConnId, { type: 'CONNECTION_OVERWRITE' })] : []),
  ]);

  return success;
};

const connect = (event) => {
  const qs = event.queryStringParameters;
  if (!qs) return softError();

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
  const openSessionId = getOpenSessionId(session.Item.type.S, targetNumMembers);

  const { memberId, memberNum } = getMember(rawMembers, { connId });
  if (memberNum === -1) return success;

  const deleteMemberInstruction = {
    Delete: {
      TableName: MEMBER_TABLE_NAME,
      Key: { id: { S: memberId } },
    },
  };

  // If the game's not started and we're the only person in it...
  if (!started && rawMembers.length === 1) {
    try {
      await transactWriteItems({
        TransactItems: [
          {
            // ... delete the session
            Delete: {
              TableName: SESSION_TABLE_NAME,
              Key: { id: { S: sessionId } },
              ConditionExpression: `
                size(members) = :one
                AND members[0].memberId = :memberId
              `,
              ExpressionAttributeValues: {
                ':memberId': { S: memberId },
                ':one': { N: '1' },
              },
            },
          },
          // ... delete the member
          { ...deleteMemberInstruction },
          // ... and also the open session (for public games)
          ...(!priv ? [{
            Delete: {
              TableName: SESSION_TABLE_NAME,
              Key: { id: { S: openSessionId } },
              ConditionExpression: 'numWaiting = :one',
              ExpressionAttributeValues: { ':one': { N: '1' } },
            },
          }] : []),
        ],
      });
    } catch (e) {
      if (e.code === 'TransactionCanceledException') return retryError();
      throw e;
    }
  } else { // Otherwise...
    try {
      await transactWriteItems({
        TransactItems: [
          {
            // ... update the session member list
            Update: {
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
            },
          },
          // ... delete the member (if the session hasn't started)
          ...(!started ? [deleteMemberInstruction] : []),
          // ... and also the open session (for pending public games)
          ...(!priv && !started ? [{
            Update: {
              TableName: SESSION_TABLE_NAME,
              Key: { id: { S: openSessionId } },
              UpdateExpression: 'ADD numWaiting :minusOne',
              ConditionExpression: 'numWaiting > :one',
              ExpressionAttributeValues: {
                ':one': { N: '1' },
                ':minusOne': { N: '-1' },
              },
            },
          }] : []),
        ],
      });
    } catch (e) {
      if (e.code === 'ConditionalCheckFailedException') return retryError();
      throw e;
    }

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

  if (!conn.Item) {
    await sendInvalidConnection(conn.Item.id.S);
    return softError();
  }

  const session = await delSession(conn.Item.sessionId.S, { ReturnValues: 'ALL_OLD' });

  if (!session.Attributes) {
    await sendInvalidConnection(conn.Item.id.S);
    return softError();
  }

  const comms = commToAllMembers(session.Attributes.members.L, { type: 'SESSION_END' });

  const delMembersNConns = DDB.batchWriteItem({
    RequestItems: {
      [MEMBER_TABLE_NAME]: session.Attributes.members.L
        .map((_) => ({ DeleteRequest: { Key: { id: { S: _.M.memberId.S } } } })),
      [CONNECTION_TABLE_NAME]: session.Attributes.members.L
        .filter((_) => _.M.connId)
        .map((_) => ({ DeleteRequest: { Key: { id: { S: _.M.connId.S } } } })),
    },
  }).promise();

  await Promise.all([comms, delMembersNConns]);

  return success;
};

/**
 * `event.body = { action: "HEARTBEAT"[, inclMessagesAfter: <int>][, waitingFor: <string[]>] }`
 */
const heartbeat = async (conn, body) => {
  const inclMessagesAfter = parseInt(body.inclMessagesAfter, 10);
  const { waitingFor } = body;
  if (
    (
      body.inclMessagesAfter !== undefined
      && Number.isNaN(inclMessagesAfter)
    )
    || (
      waitingFor !== undefined
      && (
        !Array.isArray(waitingFor)
        || waitingFor.findIndex((_) => typeof _ !== 'string') !== -1
      )
    )
  ) return softError();

  const expireAfter = getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS);
  const connId = conn.Attributes.id.S;
  const sessionId = conn.Attributes.sessionId.S;

  let session;
  try {
    session = (await (DDB.updateItem({
      TableName: SESSION_TABLE_NAME,
      Key: { id: { S: sessionId } },
      UpdateExpression: 'SET expireAfter = :expireAfter',
      ExpressionAttributeValues: { ':expireAfter': expireAfter },
      ConditionExpression: 'attribute_exists(id)',
      ReturnValues: 'ALL_OLD',
    }).promise())).Attributes;
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      await sendInvalidConnection(connId);
      return success;
    }
    throw e;
  }

  const targetNumMembers = parseInt(session.targetNumMembers.N, 10);
  const isPriv = session.isPrivate && session.isPrivate.BOOL;
  const started = session.members.L.length === targetNumMembers;
  const { memberNum, memberId } = getMember(session.members.L, { connId: conn.Attributes.id.S });
  const pinned = session.pinnedMessage && session.pinnedMessage.M;

  const messages = [{ type: 'HEARTBEAT' }];

  if (!(
    Number.isNaN(inclMessagesAfter)
    || !pinned
    || pinned.time.N <= inclMessagesAfter
  )) {
    messages.push(getMessageMessage(
      pinned.payload.S,
      pinned.time.N,
      pinned.memberNum.N,
      true,
    ));
  }

  if (
    isPriv && !started && waitingFor
    && waitingFor.indexOf('PRIVATE_SESSION_PENDING') !== -1
  ) {
    messages.push(getMessagePrivateSessionPending(
      session.id.S,
      targetNumMembers,
    ));
  }

  if (
    started && waitingFor
    && waitingFor.indexOf('SESSION_START') !== -1
  ) {
    messages.push(getMessageSessionStart(
      session.type.S,
      session.id.S,
      memberNum,
      targetNumMembers,
    ));
  }

  if (
    started && waitingFor
    && waitingFor.indexOf('SESSION_RECONNECT') !== -1
  ) {
    messages.push(getMessageSessionReconnect(
      session.members.L,
      memberNum,
      pinned,
    ));
  }

  await Promise.all([
    communicate(conn.Attributes.id.S, messages),
    updateMemberRecord(memberId, sessionId, connId),
  ]);

  return success;
};

/**
 * `event.body = { action: "SEND_MESSAGE", payload: <string>[, pinned: <bool>] }`
 */
const sendMessage = async (conn, body) => {
  if (
    typeof body.payload !== 'string'
    || ['undefined', 'boolean'].indexOf(typeof body.pinned) === -1
  ) return softError();

  const now = Date.now();
  const connId = conn.Attributes.id.S;
  const sessionId = conn.Attributes.sessionId.S;

  const session = await getSession(sessionId);
  if (!session.Item) {
    await sendInvalidConnection(connId);
    return success;
  }

  const rawMembers = session.Item.members.L;
  const { memberId, memberNum } = getMember(rawMembers, { connId });

  const updateMemberPromise = updateMemberRecord(memberId, sessionId, connId);

  try {
    await (DDB.updateItem({
      TableName: SESSION_TABLE_NAME,
      Key: { id: { S: conn.Attributes.sessionId.S } },
      UpdateExpression: `
        SET expireAfter = :expireAfter
          ${body.pinned ? ', pinnedMessage = :pinnedMessage' : ''}
      `,
      ExpressionAttributeValues: {
        ':expireAfter': getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS),
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
      ConditionExpression: 'attribute_exists(id)',
    }).promise());
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      await sendInvalidConnection(conn.Attributes.id.S);
      return success;
    }
    throw e;
  }

  await Promise.all([
    commToAllMembers(
      rawMembers,
      getMessageMessage(
        body.payload,
        now,
        memberNum,
        body.pinned,
      ),
    ),
    updateMemberPromise,
  ]);

  return success;
};

/**
 * - `event.queryStringParameters` (available on `$connect` only)
 * - `event.requestContext.routeKey` (`'$connect'`, `"$disconnect"` or `"$default"`)
 * - `event.requestContext.connectionId`
 * - `event.body` (available on `$default` only)
 */
exports.webSocketHandler = async (event) => {
  setUpAPIGW(`${event.requestContext.domainName}/${event.requestContext.stage}`);

  const route = event.requestContext.routeKey;

  if (route === '$connect') {
    console.log({ // eslint-disable-line no-console
      route,
      ...(event.queryStringParameters ? { qs: event.queryStringParameters } : {}),
    });
    return connect(event);
  }
  if (route === '$disconnect') {
    console.log({ // eslint-disable-line no-console
      route,
    });
    return disconnect(event);
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return softError();
  }

  console.log({ // eslint-disable-line no-console
    route,
    body: {
      ...body,
      ...(body.payload ? { payload: '...' } : {}),
    },
  });

  const connId = event.requestContext.connectionId;

  if (body.action === 'END_SESSION') return endSession(connId);

  const actions = ['HEARTBEAT', 'SEND_MESSAGE'];
  const fns = [heartbeat, sendMessage];
  const action = actions.indexOf(body.action);
  if (action === -1) return softError();

  const conn = await updateConnExpiration(connId);
  if (conn == null) {
    await sendInvalidConnection(connId);
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
  setUpAPIGW(WS_APIGW_ENDPOINT);

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

  const messages = {};
  const addMessage = (memberRaw, payload) => {
    const connId = memberRaw.M.connId.S;
    if (!messages[connId]) messages[connId] = [];
    messages[connId].push(payload);
  };

  const membersThatJustJoined = newRawMembers.filter(
    (nm) => oldRawMembers.findIndex(
      (om) => om.M.memberId.S === nm.M.memberId.S,
    ) === -1,
  );

  // Notify new members of their details
  membersThatJustJoined.forEach(
    (_) => addMessage(_, {
      type: 'CONNECTION',
      memberId: _.M.memberId.S,
    }),
  );

  // Notify new private session members of session details
  if (!sessionStarted && priv) {
    const privateSessionPendingMessage = getMessagePrivateSessionPending(
      session.id.S,
      targetNumMembers,
    );

    membersThatJustJoined.forEach(
      (_) => addMessage(_, privateSessionPendingMessage),
    );
  }

  // Notify members that the session has started
  if (sessionJustStarted) {
    newRawMembers.forEach((_, i) => addMessage(
      _,
      getMessageSessionStart(
        session.type.S,
        session.id.S,
        i,
        newRawMembers.length,
      ),
    ));
  }

  const connectedRawMembers = newRawMembers.filter((_) => _.M.connId);

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
      reconnectedMembers.forEach((rm) => connectedRawMembers.forEach(
        (cm) => addMessage(
          cm,
          rm.connId === cm.M.connId.S
            ? getMessageSessionReconnect(
              newRawMembers,
              rm.memberNum,
              session.pinnedMessage && session.pinnedMessage.M,
            )
            : {
              type: 'MEMBER_RECONNECT',
              memberNum: rm.memberNum,
            },
        ),
      ));
    }
  }

  await Promise.all(
    Object.keys(messages)
      .map((connId) => communicate(connId, messages[connId])),
  );

  return success;
};

exports.pingHandler = () => new Promise((r) => r({ statusCode: 200, body: 'pong' }));

exports.notifyDisconnectHandler = async (event) => {
  setUpAPIGW(WS_APIGW_ENDPOINT);

  const { memberId } = event.pathParameters;
  const memberRecord = (await (DDB.getItem({
    TableName: MEMBER_TABLE_NAME,
    Key: { id: { S: memberId } },
  }).promise())).Item;

  if (!memberRecord) return success;

  const connId = memberRecord.connId.S;
  await APIGW.deleteConnection({ ConnectionId: connId }).promise();

  return success;
};
