# Simple Relay

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
- No server-side logic, just message passing.
- No logic on the server means this is susceptible to hacking/fraud
    - If someone figures out how to send a message in your game, they can send any message they like
    - Note that this server is still "secure" (i.e. private/spoof-proof (AFAIK))
- Likely not cost-effective with many users
- Susceptible to DoS attacks - strongly recommend setting up billing limits in AWS!

Considering these caveats, this server is probably not suitable for games that "become successful".
However, I hope that it can provide a smooth multiplayer development experience to allow you to get there!

## Documentation

See [Deployment](#deployment) below for installation steps.

WIP...

### Connection

The way in which you connect to the server determines which session you join, or if you go into public matchmaking.

#### Join public session

```bash
wscat -c "wss://url/?sessionType=kubblammo&targetNumMembers=2"
```

A successful connection means you're waiting for `targetNumMembers - 1` other members to also be waiting.
When that happens you'll all be put into a session and receive a [`SESSION_START`](#session_start) message.
From then you can start sending messages to each other/performing other actions.

#### Host private session

#### Join private session

#### Rejoin session

```bash
wscat -c "wss://url/?sessionId=tN6L4cDFS&memberId=Vmp3ZUwm-Z"
```

Soon after successfully reconnecting, you should receive a [`SESSION_RECONNECT`](#session_reconnect) message
which will include any pinned message and some session details.

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

If `pinned == true` then this will set/overwrite the session's pinned message.

Pinned messages are included in [`SESSION_RECONNECT`](#session_reconnect) messages.
Use them to provide game state required to bring the game up to date upon reconnection.

#### `HEARTBEAT`

#### `END_SESSION`

```json
{"action":"END_SESSION"}
```

### Messages

The server will send messages to connected clients.

Note that messages are always contained in an array, as multiple may be sent in a single frame.

#### `PRIVATE_SESSION_PENDING`

#### `SESSION_START`

```json
{
    "memberId": "MH5SyeCo7m",
    "memberNum": 1,
    "numMembers": 2,
    "sessionId": "tp9ihEtjV",
    "sessionType": "kubblammo",
    "type": "SESSION_START"
}
```

#### `SESSION_RECONNECT`

```json
[
    {
        "memberNum": 0,
        "members": [
            true,
            true
        ],
        "pinnedMessage": {
            "memberNum": "0",
            "payload": "Hello, world!",
            "pinned": true,
            "time": "1596006870314"
        },
        "type": "SESSION_RECONNECT"
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

#### `CONNECTION_OVERWRITE`

```json
[{"type":"CONNECTION_OVERWRITE"}]
```

#### `INVALID_CONNECTION`

```json
[{"type":"INVALID_CONNECTION"}]
```

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

You can find your API Gateway Endpoint URL in the output values displayed after deployment.

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

- Confirm how `getItem` and `putItem` handle failed conditions: do they throw or return empty?
- Make lambda retry when appropriate
- Ensure lambdas are organised in consideration of retries
- Add automated clean up lambda
- Enable/disable clean up lambda automatically
- Improve/DRY up lambda and template code
- Fault tolerance analysis (race conditions; websocket frame drops; catastrophic failures)
- Improve documentation
- Investigate DoS protection strategies

### Future

- Full message persistence looped in with clean up/expiration logic
