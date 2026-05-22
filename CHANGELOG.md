# Change Log

All notable changes to this project will be documented in this file.

## Important

We highly recommend that you keep your environments up to date by upgrading to the latest version.

When applying updates, review the changes in this release alongside your current configuration to decide which features from this version to adopt.

## [1.3.0] - 2026-05-18

### New Features

- **Data Perimeter Controls (RCPs)**: Added identity and resource perimeter controls for STS, SQS, and Secrets Manager (`GRSTSDPB`, `GRSQSDPB`, `GSMDPB`) to block external principals from accessing resources in member accounts.

  **Upgrade Notes**: If any accounts have legitimate cross-account integrations with principals outside the organization, these statements will block those integrations. Use IAM Access Analyzer to review existing external access findings before deploying.

### Bug Fixes

- **Egress VPC Transit Gateway Route Table**: Fixed the egress VPC Transit Gateway attachment route table association from `tgw-rt-firewall` to `tgw-rt-spoke`. This ensures symmetric routing through the inspection VPC, which is required for stateful traffic inspection to function correctly.

  **Upgrade Notes**: This change requires **two pipeline runs** with a **change window**. Run 1 removes the existing egress VPC TGW attachment and associated routes. Run 2 re-creates the attachment with the corrected `tgw-rt-spoke` association and restores all routes. There will be connectivity downtime between Run 1 (old attachment deleted) and Run 2 (new attachment created) for traffic traversing the egress path. Perform during a scheduled change window and validate connectivity after Run 2 completes.

---

## [1.2.0] - 2026-03-20

### New Features

- **Security Hub Automation**: Added automation rules for Security Hub finding suppression with documentation for all suppressed controls
- **SSM Security**: Enabled block public sharing for SSM documents
- **LZA MCP Server**: Added LZA MCP Server description to README for AI-assisted deployment management

### Bug Fixes

- **GovCloud Configuration**: Added missing account IDs for GovCloud configurations
- **Cost**: Updated pricing documentation with networking model cost details
- **Documentation**: Fixed Mermaid diagrams not rendering on GitHub
- **Documentation**: Fixed SCP config file references in Managing SCPs guide

### Note

- **Container Deployment**: LZA now supports container-based deployment, enabling deployment in AWS regions without CodeBuild and CodePipeline support. For more information, refer to the [LZA README](https://github.com/awslabs/landing-zone-accelerator-on-aws/blob/release/v1.15.0/container/README.md).

### Contributors

We want to extend a special thank you to the following external users who have contributed to this release:

- @tvancast

## [1.1.0] - 2025-12-11

### CRITICAL

If you're on an LZA installation in a non-standard AWS partition (e.g., AWS GovCloud (US)), please do not upgrade to 1.14.0 and use 1.14.1 instead. Please see this [issue](https://github.com/awslabs/landing-zone-accelerator-on-aws/issues/972).

### New Features

- **Regional Guidance**: [Added US Federal region and industry guidance](./docs/08-Region-and-Industry-Guidance/us-federal/)
- **Cost Information**: Added pricing information to help estimate deployment costs
- **AWS Control Tower**: Updated to AWS Control Tower Landing Zone 4.0

### Improvements

- **Automated Builds**: Enhanced CI/CD with AWS GovCloud (US) package generation and security scanning
- **Documentation Updates**: Added high-level architecture and organizational unit (OU) structure diagrams

### Bug Fixes

- **Networking**: Removed internet gateway from inspection VPC
- **Documentation**: Fixed broken links and documentation errors
- **Control Tower**: Fixed issue where controls were not deploying to sub-organizational units

### Contributors

We want to extend a special thank you to the following external users who have contributed to this release:

- @Conklin-Spencer-bah

## [1.0.0] - 2025-09-29

### General Changes

- Initial General Availability (GA) release
