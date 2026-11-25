---
name: aws-guidance
description: Use for AWS tasks; consult AWS MCP servers when configured and suitable, with AWS docs, CLI, SDK and other approved sources as alternatives.
---

Use `aws-mcp` and `aws-pricing` when those servers are configured and suitable for the task. If they are unavailable, disabled, or unsuitable, use the project's approved AWS documentation, CLI, SDK, or another trusted source; state any details or checks that remain unconfirmed.

- Before an AWS task and before its first AWS CLI, `cdk`, or `sam` command, search `aws-mcp` with `mcp__aws_mcp__search_documentation` and `topics: ["agent_skills"]` when the server is available. Load a match with `mcp__aws_mcp__retrieve_skill`, passing its exact `skill_name`, and follow it over general knowledge.
- Verify AWS API parameters, permissions, limits, error codes, and regional availability against `aws-mcp` documentation tools when available; otherwise use the project's approved AWS sources and state what remains unconfirmed.
- For price estimates, use `aws-pricing` when available; otherwise use an approved pricing source. State the region, usage assumptions, and price-list date.
- Project instructions win over this guidance, including the project's infrastructure-as-code tool.
- For AWS Secrets Manager itself, retrieve the `aws-secrets-manager` skill with `mcp__aws_mcp__retrieve_skill`, passing `skill_name` exactly as the search returned it, when the AWS MCP server is configured. Never call `secretsmanager get-secret-value` or `batch-get-secret-value`.
- Use hyphens, not em dashes, in AWS resource names and descriptions.
- Before you write or change a Lambda function, read [references/lambda.md](references/lambda.md): thin handlers, one middleware model per surface, Powertools for AWS Lambda over hand-rolled code, OpenTelemetry through the ADOT layer instead of the X-Ray SDK, and runtime defaults.
- Before you write, test or review AWS CDK apps or construct libraries, read [references/cdk.md](references/cdk.md): assertions tests, cdk-nag, `cdk diff` gates, drift and cost checks.
- Before you write code that calls an AWS service's data plane (DynamoDB, Valkey, S3, SQS, Secrets Manager, Cognito tokens, RDS, OpenSearch, Kinesis, MSK, Bedrock), read [references/service-clients.md](references/service-clients.md) and use the listed library where it beats the raw SDK.
