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

Considering these caveats, this server is probably not suitable for games that "become successful".
However, I hope that it can provide a smooth multiplayer development experience to allow you to get there!

## Documentation

See [Deployment](#deployment) below for installation steps.

WIP...

### Connection

The way in which you connect to the server determines which session you join, or if you go into public matchmaking.

#### Join public session

#### Host private session

#### Join private session

#### Rejoin session

### Interaction

Connected clients can send these messages to the server.

#### `SEND_MESSAGE`

#### `HEARTBEAT`

#### `END_SESSION`

### Messages

The server will send these messages to connected clients.

#### `PRIVATE_SESSION_PENDING`

#### `SESSION_START`

#### `SESSION_RECONNECT`

#### `MESSAGE`

#### `HEARTBEAT`

#### `MEMBER_DISCONNECT`

#### `MEMBER_RECONNECT`

#### `SESSION_END`

#### `CONNECTION_OVERWRITE`

#### `INVALID_CONNECTION`

### Deployment

*Note:* The examples below use `--profile=doodadgames` (because I copy/paste them so often).
You'll need to use your own configuration instead.

```bash
sam deploy --guided --profile=doodadgames # First time deployment
sam deploy --profile=doodadgames
```

You can find your API Gateway Endpoint URL in the output values displayed after deployment.

*Note:* Each deploy uploads files to an S3 bucket, *and does not delete them*.
You may want to manually delete them to avoid costs.

__Teardown__

```bash
aws cloudformation delete-stack --stack-name simple-relay --profile=doodadgames
```

*Note:* SAM creates its own CloudFormation stack with an S3 bucket to do its own thing.
The above teardown command does not delete SAM's bucket; only the one for Simple Relay.
For a complete clean, you may want to delete that.

Not sure how if different SAM applications have different buckets, or share the same bucket though.
Exercise care if you've multiple active SAM applications active.

#### Resources

If you've not used SAM before, it's advised that you go through the introductory documentation and the first tutorial. [Get started here!](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) I could've just used vanilla CloudFormation templates, but I chose to use SAM because it simplifies the setup for common serverless services - especially lambdas.

See the [AWS SAM developer guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) for an introduction to SAM specification, the SAM CLI, and serverless application concepts.

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

### Future

- Full message persistence looped in with clean up/expiration logic
