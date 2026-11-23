---
name: aws-guidance
description: Use for any AWS task (CLI, CDK apps and tests, SAM, SDK, IaC, pricing, secrets); routes it through the AWS MCP servers and docs.
---

AWS work goes through two MCP servers: `aws-mcp` (the read-only AWS MCP Server) and `aws-pricing`. When either is not connected, say so and state which checks below stayed undone.

 - Before an AWS task and before its first AWS CLI, `cdk`, or `sam` command, search `aws-mcp` with `mcp__aws_mcp__search_documentation` and `topics: ["agent_skills"]`. Load a match with `mcp__aws_mcp__retrieve_skill`, passing its exact `skill_name`, and follow it over general knowledge.
- Verify AWS API parameters, permissions, limits, error codes, and regional availability against `aws-mcp` documentation tools. State what stayed unconfirmed.
- Price estimates with `aws-pricing`, and state the region, usage assumptions, and price-list date.
- Project instructions win over this guidance, including the project's infrastructure-as-code tool.
- For AWS Secrets Manager itself, retrieve the `aws-secrets-manager` skill with `mcp__aws_mcp__retrieve_skill`, passing `skill_name` exactly as the search returned it. Never call `secretsmanager get-secret-value` or `batch-get-secret-value`.
- Use hyphens, not em dashes, in AWS resource names and descriptions.
- Before you write or change a Lambda function, read [references/lambda.md](references/lambda.md): thin handlers, one middleware model per surface, Powertools for AWS Lambda over hand-rolled code, OpenTelemetry through the ADOT layer instead of the X-Ray SDK, and runtime defaults.
- Before you write, test or review AWS CDK apps or construct libraries, read [references/cdk.md](references/cdk.md): assertions tests, cdk-nag, `cdk diff` gates, drift and cost checks.
- Before you write code that calls an AWS service's data plane (DynamoDB, Valkey, S3, SQS, Secrets Manager, Cognito tokens, RDS, OpenSearch, Kinesis, MSK, Bedrock), read [references/service-clients.md](references/service-clients.md) and use the listed library where it beats the raw SDK.
