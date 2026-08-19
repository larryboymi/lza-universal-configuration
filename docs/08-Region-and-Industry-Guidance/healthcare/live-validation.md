# Future live validation gates

These gates are intentionally not run by the current GitHub-only workflow. Add them when a disposable AWS organization and LZA pipeline are available.

## Before connecting CI/CD to AWS

- Pin the Universal Configuration and LZA source versions by immutable tag or commit.
- Protect the deployment branch and require security, identity, network, and platform review.
- Separate build/validation from upload/deploy jobs.
- Require a manual approval before uploading configuration or starting the pipeline.
- Retain the generated configuration, composition report, LZA synthesis output, and previous known-good artifact.
- Give CI a narrowly scoped deployment role using short-lived federation.
- Ensure transformation scripts exit nonzero on every error.

## Live validation sequence

1. Create a dedicated test organization or representative non-production landing zone.
2. Run the official validator from the exact LZA version:

   ```bash
   cd <pinned-lza-source>/source
   yarn validate-config <generated-config-directory>
   ```

3. Run IAM Access Analyzer `validate-policy` for IAM policies, SCPs, and RCPs. Treat errors as failures and review warnings.
4. Synthesize every LZA stage and retain the CloudFormation templates and diff.
5. Fail review on unexplained resource deletion or replacement, especially networking, KMS, logging, backup, and organization resources.
6. Deploy the healthcare configuration with the HIPAA services SCP still unattached.
7. Confirm every LZA pipeline stage succeeds and no stack is left in rollback or failed state.
8. Verify Config recorders and delivery channels in every enabled account and Region.
9. Verify Security Hub membership, standards, aggregation, and findings after AWS evaluation has had time to run.
10. Verify GuardDuty, Macie, centralized logs, Transit Gateway flow logs, Network Firewall logs, and DNS logs reach their intended destinations.
11. Perform a backup and restore test; policy creation alone is not proof of recoverability.
12. Test SSM access, workload egress, VPC endpoints, DNS, ingress, inspection, and expected isolation paths.
13. Test the LZA, Control Tower, CloudFormation, service-linked-role, and break-glass paths against permission boundaries.

## HIPAA SCP rollout

1. Refresh the policy from the current AWS HIPAA Eligible Services Reference and record the review date.
2. Use service-last-accessed data and CloudTrail to identify required services not represented in the policy.
3. Attach only to `Workloads/PolicyStaging/Healthcare`.
4. Exercise account vending, patching, deployment, monitoring, support, billing, backup, restore, and incident-response workflows.
5. Keep a separately authenticated break-glass path and a rehearsed policy-detachment procedure.
6. Promote to healthcare Dev, then Test, then a single production canary account.
7. Observe each wave before expanding to the next OU.
8. Never make the first attachment at `Root` or a broad production OU.

## Rollback evidence

For every rollout, record:

- Git commit and generated artifact hash.
- Previous known-good artifact hash.
- LZA and Control Tower versions.
- Pipeline execution ID and CloudFormation change sets.
- Policy attachment changes.
- Resource replacements or deletions accepted during review.
- Operator and approver names.

Reapplying an old configuration does not necessarily recreate deleted data or import pre-existing resources. Backup restore and network recovery procedures therefore remain separate requirements.
