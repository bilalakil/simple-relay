# Simple Relay

_[SemVer](https://semver.org): 2.0.0_

A relay server designed especially for usage in low-communication indie games. Themes:

- Intended for early-stage indie games to provide them with rapid multiplayer iteration times
- No ongoing server fees; the server admin is charged based on how many requests are made. 0 users = $0
    - Hopefully an indie game using this would never need to turn off their servers!
- No login/authentication required: connect to a websocket and you're done
- Includes rudimentary matchmaking
- Deploy and forget: all game logic changes are made in the game client. Hopefully you can forget about this server

Caveats:

- Most suitable for games that don't communicate often, otherwise may be expensive
- Most suitable for non-realtime or slow/turn-based games, as latency will be likely be high
- No server-side logic, just message passing
- No logic on the server means this is susceptible to hacking/fraud
    - If someone figures out how to send a message in your game, they can send any message they like
    - Note that this server is still "secure" (i.e. private/spoof-proof (AFAIK))
- Likely not cost-effective with many users
- Susceptible to DoS attacks - strongly recommend setting up billing limits in AWS!

Considering these caveats, this server is probably not suitable for games that "become successful".
However, I hope that it can provide a smooth multiplayer development experience to allow you to get there!

Important missing features:
- Currently only a single pinned message is stored against the session.
  All non-pinned messages are relayed and forgotten, and so won't be restored via [`HEARTBEAT`](#heartbeat).

## Documentation

See [Deployment](#deployment) below for installation steps.

Note that there are two different domains/URLs that are output from deployment -
one for the HTTPS API and one for the WSS API.

### Connection

The way in which you connect to the server determines which session you join, or if you go into public matchmaking.

#### Test connectivity

```bash
curl https://httpsApiUrl/ping
```

If this responds with status code 200 then you should be clear to try and connect to the websocket.

It's suggested to check this before attempting connection to the websocket.
The WS(S) protocol doesn't have standard support for error/response codes like HTTP does -
if the WSS connection fails then you won't know the reason why.

Thus it can be useful to rule out a connectivity issue (using this API) -
then WSS connection issues are more likely to be fatal (i.e. session deleted).

#### Join public session

```bash
wscat -c "wss://wsApiUrl/?sessionType=kubblammo_3.0.0&targetNumMembers=2"
```

A successful WS connection means you're waiting for `targetNumMembers - 1` other members to also be waiting.
When that happens you'll all be put into a session and receive a [`SESSION_CONNECT`](#session_connect) message.
From then you can start sending messages to each other/performing other actions.

#### Host private session

```bash
wscat -c "wss://wsApiUrl/?sessionType=kubblammo_3.0.0&targetNumMembers=2&private=true"
```

The same post-connection behaviour applies as to when [joining a public session](#join-public-session).

Additionally, you will receive a [`PRIVATE_SESSION_PENDING`](#private_session_pending) message
containing the details you need to share with other people so they can join the session.

#### Join private session

```bash
wscat -c "wss://wsApiUrl/?sessionType=kubblammo_3.0.0&sessionId=IIFY26O6Q"
```

The same post-connection behaviour applies as to when [hosting a private session](#host-private-session)
(except that the `PRIVATE_SESSION_PENDING` message will not be sent if you joining caused the session to start).

#### Rejoin session

```bash
wscat -c "wss://wsApiUrl/?memberId=Vmp3ZUwm-Z"
# or
wscat -c "wss://wsApiUrl/?memberId=Vmp3ZUwm-Z&sessionId=IIFY26O6Q"
```

This will re-establish your connection to any session that you were connected to in the past,
including private/open sessions that were still pending more members.

If your session had started, you should receive a [`SESSION_CONNECT`](#session_connect) message
which will include any pinned message and some session details.

By providing a session ID in addition to your member ID,
a reconnection can be made even if your member details had expired due to inactivity
(provided some other members kept the session alive).

#### Notify of disconnection

```bash
curl https://httpsApiUrl/notifyDisconnect/{memberId}
```

Web socket disconnection handling is a flakey thing.
To minimise inconvenience to other users in the case that web socket disconnection failed
(including to the same user, i.e. in case they match make with a past-disconnected-self),
clients should explicitly notify the service of disconnection,
especially if due to network failure.

### Actions

Connected clients can send these messages to the server to perform various actions.

#### `SEND_MESSAGE`

```json
{
    "action": "SEND_MESSAGE",
    "payload": "Hello, world!",
    "pinned": true
}
```

Broadcasts the payload to all members that are connected to the session.

If `pinned == true` then this will set/overwrite the session's pinned message.

Pinned messages are included in [`SESSION_CONNECT`](#session_connect) messages.
Use them to provide game state required to bring the game up to date upon reconnection.

#### `HEARTBEAT`

```json
{
    "action": "HEARTBEAT",
    "inclMessagesAfter": 1596933878705,
    "waitingFor": ["CONNECTION","PRIVATE_SESSION_PENDING", "SESSION_CONNECT"]
}
```

`inclMessagesAfter` and `waitingFor` are optional.

`waitingFor` accepts a list of strings, with the three relevant string values listed in the example.
If included with the heartbeat, those messages will be sent back to the client with the heartbeat response
(if they should've been sent in the first place).
Thus this can be used to alleviate potential gaps in message communication.

See [`HEARTBEAT` (Messages)](#heartbeat-1) for an example response.

#### `END_SESSION`

```json
{"action":"END_SESSION"}
```

### Messages

The server will send messages to connected clients.

Note that messages are always contained in an array, as multiple may be sent in a single frame.

#### `CONNECTION`

```json
[
    {
        "memberId": "MH5SyeCo7m",
        "type": "CONNECTION"
    }
]
```

This message is provided as soon as possible following web socket connection.

The member ID can be used to [rejoin the session](#rejoin-session) in future
and should be treated as securely as possible,
since if it was shared then other clients would be able to spoof your user,
and send/receive messages as though they were you.

#### `PRIVATE_SESSION_PENDING`

```json
[
    {
        "sessionId": "IIFY26O6Q",
        "targetNumMembers": 2,
        "type": "PRIVATE_SESSION_PENDING"
    }
]
```

#### `SESSION_CONNECT`

```json
[
    {
        "memberNum": 1,
        "memberPresence": [
            true,
            true
        ],
        "pinnedMessage": {
            "memberNum": "0",
            "payload": "Hello, world!",
            "pinned": true,
            "time": "1596006870314"
        },
        "sessionId": "tp9ihEtjV",
        "sessionType": "kubblammo_3.0.0",
        "type": "SESSION_START"
    }
]
```

#### `MESSAGE`

```json
[
    {
        "memberNum": 0,
        "payload": "Hello, world!",
        "pinned": true,
        "time": 1596006870314,
        "type": "MESSAGE"
    }
]
```

#### `HEARTBEAT`

```js
[
    {
        "type": "HEARTBEAT"
    },
    {
        "type": "MESSAGE"
        // ...
        // Only if `inclMessagesAfter` is lower than the time of the session's pinned message.
        // See `MESSAGE` for example
    },
    {
        "type": "CONNECTION"
        // ...
        // Only if `waitingFor` includes `CONNECTION`.
        // See `CONNECTION` for example
    },
    {
        "type": "PRIVATE_SESSION_PENDING"
        // ...
        // Only if `waitingFor` includes `PRIVATE_SESSION_PENDING` (and valid).
        // See `PRIVATE_SESSION_PENDING` for example
    },
    {
        "type": "SESSION_CONNECT"
        // ...
        // Only if `waitingFor` includes `SESSION_CONNECT` (and valid).
        // See `SESSION_CONNECT` for example
    }
]
```

The heartbeat message simply informs you that the server received your beat,
but can be used to fetch potentially missed information.

If `inclMessagesAfter` is set in [the action](#heartbeat),
any messages stored (currently only a pinned message) after that time will sent as additional array elements,
which are in the same format as [regular messages](#message).

Currently only pinned messages are stored by Simple Relay, and so only they could be returned.
In future, if all messages are stored (not only pinned), then all relevant ones would be included here too.

If `waitingFor` is set in [the action](#heartbeat)
then various different pieces of information may be sent with the heartbeat,
according to what is listed in `waitingFor`, and the current state of the session.

#### `MEMBER_DISCONNECT`

```json
[
    {
        "memberNum": 1,
        "type": "MEMBER_DISCONNECT"
    }
]

```

#### `MEMBER_RECONNECT`

```json
[
    {
        "memberNum": 1,
        "type": "MEMBER_RECONNECT"
    }
]
```

#### `SESSION_END`

```json
[{"type":"SESSION_END"}]
```

This is sent when a member issues the [`END_SESSION`](#end_session) action, and thus the session is terminated.

You will not receive any more messages, and cannot issue any more actions, from this web socket.

#### `CONNECTION_OVERWRITE`

```json
[{"type":"CONNECTION_OVERWRITE"}]
```

A new web socket connection with your member ID was made elsewhere, overwriting your current connection.

You will not receive any more messages, and cannot issue any more actions, from this web socket.

#### `INVALID_CONNECTION`

```json
[{"type":"INVALID_CONNECTION"}]
```

Your current web socket connection is invalid - you should attempt [rejoin the session](#rejoin-session).

You will not receive any more messages, and cannot issue any more actions, from this web socket.

### Deployment

*Note:* The examples below use `--profile=doodadgames` (because I copy/paste them so often).
You'll need to use your own configuration instead.

#### Dependencies

- [AWS SAM](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)

#### Up

```bash
sam deploy --guided --profile=doodadgames # First time deployment
sam deploy --profile=doodadgames
```

You'll find API Gateway URLs in the output values after deployment,
or in API Gateway in the AWS console afterwards (API > Stages > Prod > WebSocket URL for the WSS URL).
There's one URL for the HTTPS API, and another for the WSS API.

#### Down

```bash
aws cloudformation delete-stack --stack-name simple-relay --profile=doodadgames
```

*Note:* SAM creates its own CloudFormation stack with an S3 bucket to do its own thing.
The above teardown command does not delete SAM's bucket; only the one for Simple Relay.
For a complete clean, you may want to delete that manually, BUT...

Not sure if different SAM applications have different buckets, or share the same bucket though.
Exercise care if you've multiple active SAM applications active.

## Client Support

- I've made a Unity client within [my Unity library package](https://github.com/bilalakil/my-unity-library)

## Todo

Until these are all done, the presence of this code on GitHub serves more as a personal backup than anything else.

- Improve error handling
- Make lambda retry when appropriate
- Improve/DRY up lambda and template code
- Fault tolerance analysis (race conditions; websocket frame drops; catastrophic failures)
- Improve documentation
- Investigate DoS protection strategies

### Future

- Full message persistence looped in with clean up/expiration logic
