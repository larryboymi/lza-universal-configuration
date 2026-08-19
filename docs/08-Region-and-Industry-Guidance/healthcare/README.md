# Healthcare profile

The healthcare profile adds a small set of healthcare-specific decisions to the current Universal Configuration. It does not replace the base configuration and it does not claim that an environment is HIPAA compliant.

The central idea is simple:

```text
Universal base + hub-and-spoke network + healthcare overlay = generated LZA configuration
```

The base remains the source of truth for security services, organization-wide guardrails, backups, logging, and IAM. The healthcare directory contains only the differences that have a healthcare reason.

## What the profile changes

The profile:

- Adds healthcare child OUs beneath Policy Staging, Dev, Test, and Prod.
- Keeps the `Network` account as the hub owner for Transit Gateway, IPAM, inspection, and central endpoints.
- Shares the appropriate hub and IPAM resources with the new healthcare OUs.
- Adds standardized `Environment` and `DataClassification` tag values, including `PHI`.
- Changes the CloudWatch Logs retention selection from 365 to 3,653 days.
- Adds a HIPAA-eligible-services SCP in an intentionally unattached state.
- Records CIS v3 Level 1 as the adherence target while keeping Level 2 checks visible.

It deliberately does not copy the historical healthcare network, account list, backup plan, duplicate accelerator policies, or MFA permission boundaries.

## Directory layout

```text
modules/industry/healthcare/
├── profile.yaml
├── service-control-policies/
│   └── healthcare-hipaa-eligible-services.json
└── tagging-policies/
    └── healthcare-data-classification.json
```

`profile.yaml` is both the machine-readable overlay and a concise declaration of important decisions. The composer refuses implicit overwrites: additions must be unique, and replacements must state the exact value they expect to replace.

## Build locally

Install the existing script dependency:

```bash
cd scripts
pnpm install --frozen-lockfile
```

From the repository root, compose into a new directory:

```bash
node scripts/compose-config.js \
  --base modules/base/default \
  --network modules/network/hub-and-spoke \
  --profile modules/industry/healthcare \
  --output build/healthcare-hub-and-spoke
```

Validate the result without AWS credentials:

```bash
node scripts/validate-generated-config.js \
  --config build/healthcare-hub-and-spoke \
  --profile modules/industry/healthcare
```

Download and hash-check the schemas from the pinned LZA v1.16.0 commit, then run exact schema validation:

```bash
cd scripts
pnpm schemas:download
cd ..
node scripts/validate-lza-schema.js \
  --config build/healthcare-hub-and-spoke \
  --schemas scripts/.cache/lza-schemas/1.16.0
```

The schema downloader refuses unexpected content: every schema URL is pinned to an immutable LZA commit and every downloaded file must match its committed SHA-256 value.

The output directory must not already exist. Choose a fresh path or remove a previous generated directory after confirming it is disposable. Generated output is ignored by Git; source modules and tests are committed.

## Deterministic variants

The four command-line inputs are the composition boundary. A different base, network module, or profile produces a different deterministic result; identical source inputs produce identical generated file hashes. The output path itself does not affect those hashes.

Do not edit files beneath `build/`. To create a durable variant, copy `modules/industry/healthcare` to a new source-controlled profile directory, give `profile.id` a unique value, and change its `assets` or `operations`. Then pass that directory to `--profile` and use a new `--output` path. Keep the compatibility fields and healthcare invariants unless the new profile intentionally has a different specification and validator.

The supported operations are:

| Operation | Use | Drift behavior |
|---|---|---|
| `appendUniqueObject` | Add a named OU, policy, or other object. | An identical object is unchanged; the same identity with different content fails. |
| `appendUniqueScalar` | Add an OU or account name to an existing list. | An existing value is unchanged. |
| `set` | Change an existing scalar or object. | The current value must equal `expected`, otherwise composition fails. |
| `assets` | Add a profile-owned policy or other referenced file. | A destination collision fails. |

For example, a 7-year log-retention variant would change only this operation in the derived profile:

```yaml
- op: set
  file: global-config.yaml
  path: /cloudwatchLogRetentionInDays
  expected: 365
  value: 2557
```

`expected` describes the value in the selected base—not the previously generated healthcare value. This is intentionally **not** a value in `replacements-config.yaml`: replacement tokens are for deployment/environment values, while retention is a reviewed profile decision. Re-run the complete build and validation commands for every variant and commit the source profile, not generated output.

## Understanding the generated report

`composition-report.json` includes:

- The selected base, network, and profile inputs.
- Every asset and overlay operation.
- Whether an operation added, updated, or left a value unchanged.
- A SHA-256 hash for each generated file.

The validator recalculates these hashes. A mismatch means something edited the generated configuration after composition.

The repository also maps each source configuration file to the immutable LZA v1.16.0 JSON Schema in `.vscode/settings.json`. With the VS Code YAML extension installed, source files receive schema diagnostics and completion. Both command-line validators remain necessary: one checks the exact LZA schemas after typed replacement materialization, while the other checks cross-file references, policy sizes, profile invariants, and generated hashes.

## CIS Level 1 versus Level 2

“Level” and “version” mean different things:

- The configured benchmark version is CIS AWS Foundations Benchmark **v3.0.0**.
- The healthcare adherence target is CIS profile **Level 1**.
- Level 2 controls remain visible as detective findings and do not deny workload operations.

LZA does not provide a simple `level: 1` field. It supports a list named `controlsToDisable`. Comments beside the CIS v3 standard show where a reviewed Level 2 exclusion list could be added later. This profile intentionally does not guess that list or equate severity with CIS level.

The operative setting is in `modules/base/default/security-config.yaml`, under:

```text
centralSecurityServices.securityHub.standards
  -> CIS AWS Foundations Benchmark v3.0.0
  -> controlsToDisable
```

The healthcare `profile.cis` block is decision metadata checked by the offline validator; it does not itself configure Security Hub. The current CIS standard targets `Root`, so adding IDs to this base entry changes the standard for healthcare **and every other included account**. Do not use it for a healthcare-only exception without first redesigning the Security Hub standard deployment targets into disjoint account/OU scopes and adding validation for that design. For an organization-wide reviewed exclusion, uncomment `controlsToDisable` at the location above, add exact control IDs for the configured benchmark version, and run all offline checks.

## Permission boundaries

The profile retains the Universal Configuration boundary and does not import either historical healthcare MFA boundary. The historical files and their disposition are:

| Historical policy | Original use | Disposition |
|---|---|---|
| `Default-Boundary-Policy` (`boundary-policy.json`) | Attached to sample EC2/SSM, Backup, and Budgets service roles in every account. | Not ported. Its `Allow *` provides no service ceiling; its session-MFA deny is not appropriate for AWS service roles. Current Universal roles/policies supersede the sample role definitions. |
| `IAM-User-Boundary-Policy` (`iam-user-boundary-policy.json`) | Attached to two Management-account break-glass IAM users. | Not ported. The IAM-user/MFA bootstrap pattern is separate from workload-role authorization and should be replaced by the approved Identity Center and break-glass design. |

Their limited value is historical design evidence: they show an intent to require MFA for interactive principals. They are not useful templates for modern application-role boundaries. If IAM break-glass users remain a requirement, design and test that control separately rather than reusing these policies.

Use this decision model:

| Principal | Recommended approach |
|---|---|
| Human workforce | IAM Identity Center permission sets; avoid IAM users. |
| LZA and Control Tower roles | Exempt from workload boundaries and protect with existing guardrails. |
| AWS service-linked roles | Do not attach customer boundaries. |
| Standard SSM instance role | Retain the existing Universal boundary attachment. |
| Application runtime roles | Create workload-specific boundaries after required AWS services are known. |
| Delegated role builders | Require an approved boundary when creating roles and prevent modification of the boundary policy. |

The existing boundary is broad by design and is not evidence that every future workload role is least privilege. It is a maximum-permissions guardrail. Each role still needs a suitably narrow identity policy.

## Before using the HIPAA service allow-list

The SCP is copied as a staged reference from the historical healthcare sample revision recorded in `profile.yaml`. It is time-sensitive because the HIPAA-eligible service list changes.

Before attaching it:

1. Compare it with the then-current AWS HIPAA Eligible Services Reference.
2. Validate it with IAM Access Analyzer as a service control policy.
3. Review CloudTrail and service-last-accessed data for the canary account.
4. Confirm LZA, Control Tower, security, backup, logging, support, billing, and break-glass operations are included.
5. Attach it only to `Workloads/PolicyStaging/Healthcare` first.
6. Move or create a disposable canary account there and complete the live test plan.

An empty deployment-target list is a safety property enforced by offline validation.

### SCP targeting quick start

The historical policy is an AWS Organizations SCP. LZA can name accounts in `deploymentTargets.accounts`, but this profile intentionally stages the policy against an OU workflow so inheritance and rollback are explicit. It is not intended to be attached directly to the `Network`, Management, Log Archive, Audit, or other infrastructure accounts.

1. Leave the committed source at `organizationalUnits: []` for the initial configuration deployment.
2. Complete the reviews above and create or move only a disposable workload canary account into `Workloads/PolicyStaging/Healthcare`.
3. In a reviewed derived profile, change the SCP operation to:

   ```yaml
   deploymentTargets:
     organizationalUnits:
       - Workloads/PolicyStaging/Healthcare
   ```

4. Compose to a fresh output directory and run semantic, network, and pinned-schema validation.
5. Deploy and test the canary using the live-validation checklist. Remove the OU target to roll back the attachment.
6. Only after successful evidence review, create an explicitly approved variant targeting one healthcare environment OU at a time. Do not target `Root`.

Changing this target intentionally produces a different composition report and file hashes. Keep each approved source variant in its own profile directory if staging and production outcomes must remain reproducible at the same time.

## Related material

- [Feature specification](../../../specs/healthcare-overlay.md)
- [Control decisions](control-decisions.md)
- [Future live validation](live-validation.md)
