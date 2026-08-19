# Healthcare control decisions

This record explains what was taken from the historical healthcare sample and what was intentionally left behind.

| Area | Decision | Reason |
|---|---|---|
| Universal base | Retain | It targets the current LZA version and contains newer guardrails and security-service configuration. |
| Hub network | Retain current hub-and-spoke module | The `Network` account already owns Transit Gateway, IPAM, inspection, DNS firewall, and endpoint hub resources. |
| Historical healthcare network | Do not port | It uses older names, fixed CIDRs, and an older LZA schema. |
| Healthcare OUs | Adapt | Healthcare becomes a child of environment OUs so existing environment guardrails still inherit. |
| PHI/data-classification tags | Port and simplify | Classification is healthcare-specific; the sample CostCenter value was an unusable example. |
| Tag enforcement | Use with caveat | AWS tag policies standardize tags that exist; they do not prove that every resource has a tag. Separate detective controls are still needed. |
| HIPAA services SCP | Stage unattached | An allow-list can immediately break required services and becomes stale as AWS eligibility changes. |
| Accelerator/quarantine SCPs | Do not port | Current Universal policies supersede them and include newer protections. |
| Backup policy | Retain Universal | The current plan is more complete, multi-Region aware, and aligned with the current IAM backup role. |
| Log retention | Select 3,653 days | This preserves the historical healthcare intent as an explicit profile choice; legal, records, and cost owners must approve it before deployment. |
| Security Hub | Retain Universal | Current FSBP, NIST, and CIS v3 coverage supersedes the older sample configuration. |
| CIS profile | Level 1 target, Level 2 monitor | Level 2 findings are useful evidence but should not be confused with preventative enforcement or workload compatibility. |
| Macie | Retain enabled | The historical sample disabled it; sensitive-data discovery is valuable for healthcare workloads. |
| GuardDuty | Retain current | Current configuration includes newer protections such as EKS coverage. |
| Audit Manager | Do not enable automatically | Evidence ownership, framework selection, and cost need an organization decision. |
| Detective | Do not enable automatically | Useful but not required to compose the profile; decide with the security operations model and regional availability. |
| Custom Config rules | Do not duplicate | Existing Security Hub, AWS Config, and Universal remediations cover most historical intent. Add a rule only after documenting a measured gap. |
| Historical `Default-Boundary-Policy` | Do not port | It allows all actions before applying a session-MFA deny and was attached even to AWS service roles. The current role definitions supersede it, and service sessions cannot satisfy a human MFA pattern. |
| Historical `IAM-User-Boundary-Policy` | Do not port | It was limited to two Management-account break-glass IAM users. That IAM-user bootstrap model is not a workload-role boundary; use the approved Identity Center and separately tested break-glass design. |
| Universal boundary | Retain | It protects central roles/networking and supports bounded delegated role creation. Broader attachment still requires workload testing. |

## Items requiring an owner before live deployment

- Compliance owner: confirm CIS benchmark version and Level 1 scope.
- Privacy/security owner: define what data receives the `PHI` classification.
- Legal/records owner: approve 3,653-day retention and any longer immutable archive requirement.
- FinOps owner: estimate logging, Config, Security Hub, Macie, GuardDuty, Network Firewall, and backup costs.
- Identity owner: approve which teams may create roles and which workload-specific boundaries they must use.
- Network owner: approve healthcare CIDR demand and whether the existing Dev/Test/Prod IPAM pools provide enough isolation.
- Incident response owner: test break-glass and quarantine procedures under the service allow-list.
