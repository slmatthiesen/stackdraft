# Self-host deployment (budget tier)

`budget.reference.tf` is the **budget-tier** reference Terraform for hosting this
site, pulled from Drafture's own `/api/config` for the `self-hosting-a-stateful-web-app`
design — i.e. the product describing its own deployment (dogfood).

Shape: a single public **t4g.small** EC2 box with a public IP behind a security group
that only admits **Cloudflare** IP ranges (no NAT gateway, no ALB), the SQLite DB on a
**separate encrypted EBS volume** with DLM snapshot backups, CloudFront + OAC for the
static SPA assets, and the full security floor (KMS, CloudTrail, IAM instance profile,
CloudWatch logs/alarms → SNS). ~$14–42/mo.

> ⚠ **Reference only.** AI-generated starting point — read it, `terraform plan`, and set
> a billing budget before applying. You own every resource it creates.

## Required variables (no defaults)

| var | what |
|---|---|
| `vpc_id` | existing VPC to deploy into |
| `public_subnet_id` | public subnet for the EC2 instance |
| `ops_email` | address for SNS ops-alert subscription |
| `container_image` | the app image you built + pushed (ECR/GHCR/Docker Hub) |
| `static_site_domain` | domain CloudFront serves the SPA assets on (needs an ACM cert) |

`aws_region` (us-east-1), `project` (drafture), `ami_id` (empty → auto-resolves the
latest AL2023 arm64 AMI), `container_port` (8080), and the Cloudflare IP ranges all have
defaults. Keep the CF ranges current (links are in the file). Copy
`terraform.tfvars.example` → `terraform.tfvars` and fill it in.

`user_data` now does the full box bootstrap AND app deploy: mounts the encrypted EBS
volume for SQLite, installs Docker, reads the Anthropic key from SSM, and runs
`container_image` (host `:80` → container `:container_port`, data volume at `/app/data`).
Cloudflare terminates TLS and proxies to `:80`.

## Deploy, end to end

```
# 1. Build + push the image (from the repo root)
# The box is arm64 (t4g) — build for linux/arm64 or the box can't run it
# ("no matching manifest for linux/arm64"). buildx --push builds + uploads in one step.
aws ecr create-repository --repository-name drafture --region us-east-1   # once
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
docker buildx build --platform linux/arm64 -t <acct>.dkr.ecr.us-east-1.amazonaws.com/drafture:latest --push .

# 2. Plan + apply (tofu or terraform)
cd deploy/self-host
cp terraform.tfvars.example terraform.tfvars   # then edit it
tofu init
tofu plan     # review every resource + the resolved AMI
tofu apply

# 3. Set the Anthropic key (out-of-band; never in a committed file)
aws ssm put-parameter --overwrite --type SecureString \
  --name /drafture/anthropic_api_key --value sk-ant-... --region us-east-1

# 3b. (optional) LLM observability — set enable_langfuse=true in tfvars, then set the keys:
aws ssm put-parameter --overwrite --type SecureString \
  --name /drafture/langfuse_public_key --value pk-lf-... --region us-east-1
aws ssm put-parameter --overwrite --type SecureString \
  --name /drafture/langfuse_secret_key --value sk-lf-... --region us-east-1

# 4. Point a PROXIED Cloudflare record at the `ec2_public_ip` output, then smoke test
curl -s https://<your-domain>/api/health     # -> {"status":"ok",...}
```

LLM observability is optional and off by default. With `enable_langfuse = true` and the
two keys set above, the box traces every LLM call (prompt, completion, tokens, USD cost,
latency) to your Langfuse project. Without them the app runs identically, untraced.

**Optional local smoke test before deploying** (proves the image serves with the deploy's
env, $0, no AWS): from the repo root —
```
docker build -t drafture:local .
docker run --rm -p 8080:8080 -e STORE_BACKEND=sqlite -e ANTHROPIC_API_KEY=dummy drafture:local
curl -s localhost:8080/api/health
```

**Seed the gallery** (curated examples are gitignored, not in the image): after the box is
up, either ship your local `data/drafture.db` onto the volume, or run `seed-curated` once
(~$0.60, a real paid generation). Empty otherwise.

To regenerate this file after a design change: open the design in the app and pull
Terraform for the budget tier again (the deterministic emitter now covers the EBS volume).
