# Simple Relay

## Todo

Until these are all done, the presence of this code on GitHub serves more as a personal backup than anything else.

- Add support for "session pinned payload"
- Confirm how `getItem` and `putItem` handle failed conditions: do they throw or continue execution?
- Make lambda retry when appropriate
- Ensure lambdas are organised in consideration of retries
- Add expiration timers and an automated clean up lambda
- Enable/disable clean up lambda automatically
- Improve/DRY up lambda and template code
- Fault tolerance analysis (race conditions; websocket frame drops; catastrophic failures)
- Improve documentation

## Useful Commands

*Note:* The examples below use `--profile=doodadgames` (because I copy/paste them so often).
You'll need to use your own configuration instead.

__Build__

```bash
sam build
```

__Deployment__

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

## Resources

If you've not used SAM before, it's advised that you go through the introductory documentation and the first tutorial. [Get started here!](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) I could've just used vanilla CloudFormation templates, but I chose to use SAM because it simplifies the setup for common serverless services - especially lambdas.

See the [AWS SAM developer guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) for an introduction to SAM specification, the SAM CLI, and serverless application concepts.
