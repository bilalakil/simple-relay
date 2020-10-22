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

const getExpirationTime = (afterSeconds) => Math.floor(Date.now() / 1000) + afterSeconds;

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
        ':expireAfter': { N: getExpirationTime(CONNECTION_EXPIRE_AFTER_SECONDS).toString() },
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

const getMessageSessionStart = (sessionType, sessionId, memberNum, memberId, numMembers) => ({
  type: 'SESSION_START',
  sessionType,
  sessionId,
  memberNum,
  memberId,
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

  try {
    await transactWriteItems({
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
        ...(isNewPublic ? [{
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
        }] : []),
      ],
    });
  } catch (e) {
    if (e.code === 'TransactionCanceledException') {
      if (e.cancellationReasons[1].Code === 'ConditionalCheckFailed') return softError();
      if (e.cancellationReasons[2].Code === 'ConditionalCheckFailed') return retryError();
    }
    throw e;
  }

  // Members are notified of session start via `sessionMembersChangedHandler`
  // Open sessions for full sessions are deleted via `sessionMembersChangedHandler`

  return success;
};

const rejoinSession = async (event) => {
  const qs = event.queryStringParameters;
  const connId = event.requestContext.connectionId;

  // Validate input
  // `?sessionId=<string>&memberId=<string>`
  if (!(qs.sessionId && qs.memberId)) return softError();

  const session = await getSession(qs.sessionId);

  if (!session.Item) return softError();
  const rawMembers = session.Item.members.L;

  const {
    memberNum,
    connId: oldConnId,
  } = getMember(rawMembers, { memberId: qs.memberId });

  if (memberNum === -1) return softError();
  const newMember = { M: { memberId: { S: qs.memberId }, connId: { S: connId } } };
  const expireAfter = { N: getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS).toString() };

  await Promise.all([
    transactWriteItems({
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
    }),
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
    try {
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

  const session = await delSession(conn.Item.sessionId.S, { ReturnValues: 'ALL_OLD' });

  if (!session.Attributes) {
    await sendInvalidConnection(conn.Item.id.S);
    return softError();
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

  let session;
  try {
    session = (await (DDB.updateItem({
      TableName: SESSION_TABLE_NAME,
      Key: { id: { S: conn.Attributes.sessionId.S } },
      UpdateExpression: 'SET expireAfter = :expireAfter',
      ExpressionAttributeValues: {
        ':expireAfter': { N: getExpirationTime(SESSION_EXPIRE_AFTER_SECONDS).toString() },
      },
      ConditionExpression: 'attribute_exists(id)',
      ReturnValues: 'ALL_OLD',
    }).promise())).Attributes;
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      await sendInvalidConnection(conn.Attributes.id.S);
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
    || pinned.M.time.N <= inclMessagesAfter
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
      memberId,
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

  await communicate(conn.Attributes.id.S, messages);

  return success;
};

/**
 * `event.body = { action: "SEND_MESSAGE", payload: <string>[, pinned: <bool>] }`
 */
const sendMessage = async (conn, body) => {
  if (
    typeof body.payload !== 'string'
    || (typeof body.pinned).indexOf('undefined', 'boolean') === -1
  ) return softError();

  const now = Date.now();

  const session = await getSession(conn.Attributes.sessionId.S);
  if (!session.Item) {
    await sendInvalidConnection(conn.Attributes.id.S);
    return success;
  }

  const rawMembers = session.Item.members.L;
  const { memberNum } = getMember(rawMembers, { connId: conn.Attributes.id.S });

  try {
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
      ConditionExpression: 'attribute_exists(id)',
    }).promise());
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      await sendInvalidConnection(conn.Attributes.id.S);
      return success;
    }
    throw e;
  }

  await commToAllMembers(
    rawMembers,
    getMessageMessage(
      body.payload,
      now,
      memberNum,
      body.pinned,
    ),
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
      getMessagePrivateSessionPending(
        session.id.S,
        targetNumMembers,
      ),
    );
  }

  // Notify members that the session has started
  if (sessionJustStarted) {
    await Promise.all(
      newRawMembers.map((_, i) => communicate(
        _.M.connId.S,
        getMessageSessionStart(
          session.type.S,
          session.id.S,
          i,
          _.M.memberId.S,
          newRawMembers.length,
        ),
      )),

      // ... and delete open session if public
      ...(!priv ? [delSession(getOpenSessionId(
        session.type.S,
        session.targetNumMembers.N,
      ))] : []),
    );
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
      await Promise.all(
        reconnectedMembers.map((rm) => Promise.all(connectedRawMembers.map((
          (cm) => communicate(
            cm.M.connId.S,
            rm.connId === cm.M.connId.S
              ? getMessageSessionReconnect(
                connectedRawMembers,
                rm.memberNum,
                session.pinnedMessage && session.pinnedMessage.M,
              )
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

exports.pingHandler = () => new Promise((r) => r({ statusCode: 200, body: 'pong' }));
