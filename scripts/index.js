const yaml = require("js-yaml");
const fs = require("fs");

const args = process.argv.slice(2);
const inputFolder = args[0];
const accountsConfigFilename = `${inputFolder}/accounts-config.yaml`;
const replacementsConfigFilename = `${inputFolder}/replacements-config.yaml`;

try {
  //
  // Replacements Config Changes
  //

  const replacementsConfig = yaml.load(
    fs.readFileSync(replacementsConfigFilename, "utf8")
  );

  replacementsConfig.globalReplacements.forEach((item, i) => {
    // Replace the enabled regions
    if (item.key === "HomeRegion") {
      replacementsConfig.globalReplacements[i].value = process.env.HOME_REGION;
    }
    // Replace the enabled regions
    else if (item.key === "EnabledRegions") {
      replacementsConfig.globalReplacements[i].value =
        `${process.env.ENABLED_REGIONS}`.split(",");
    }
    // Replace email values in replacements config
    else if (item.key === "BudgetsEmail") {
      replacementsConfig.globalReplacements[
        i
      ].value = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-budgets@${process.env.EMAIL_DOMAIN}`;
    } else if (item.key === "SecurityHigh") {
      replacementsConfig.globalReplacements[
        i
      ].value = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-security-high@${process.env.EMAIL_DOMAIN}`;
    } else if (item.key === "SecurityMedium") {
      replacementsConfig.globalReplacements[
        i
      ].value = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-security-medium@${process.env.EMAIL_DOMAIN}`;
    } else if (item.key === "SecurityLow") {
      replacementsConfig.globalReplacements[
        i
      ].value = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-security-low@${process.env.EMAIL_DOMAIN}`;
    }
  });

  console.log(replacementsConfig);
  fs.writeFileSync(
    replacementsConfigFilename,
    yaml.dump(replacementsConfig),
    "utf8"
  );

  //
  // Accounts Config Changes
  //

  const accountsConfig = yaml.load(
    fs.readFileSync(accountsConfigFilename, "utf8")
  );

  accountsConfig.mandatoryAccounts.forEach((item, i) => {
    if (item.name === "Management") {
      accountsConfig.mandatoryAccounts[
        i
      ].email = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-management@${process.env.EMAIL_DOMAIN}`;
    } else if (item.name === "LogArchive") {
      accountsConfig.mandatoryAccounts[
        i
      ].email = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-logarchive@${process.env.EMAIL_DOMAIN}`;
    } else if (item.name === "Audit") {
      accountsConfig.mandatoryAccounts[
        i
      ].email = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-audit@${process.env.EMAIL_DOMAIN}`;
    }
  });

  accountsConfig.workloadAccounts.forEach((item, i) => {
    if (item.name === "SharedServices") {
      accountsConfig.workloadAccounts[
        i
      ].email = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-sharedservices@${process.env.EMAIL_DOMAIN}`;
    } else if (item.name === "Network") {
      accountsConfig.workloadAccounts[
        i
      ].email = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-network@${process.env.EMAIL_DOMAIN}`;
    } else if (item.name === "Perimeter") {
      accountsConfig.workloadAccounts[
        i
      ].email = `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${process.env.AWS_DEFAULT_REGION}-perimeter@${process.env.EMAIL_DOMAIN}`;
    }
  });

  for (let i = 1; i <= process.env.WORKLOAD_DEV_ACCOUNTS || 0; i++) {
    accountsConfig.workloadAccounts.push(
      getWorkloadAccounts(
        `Dev${i.toString().padStart(5, "0")}`,
        "Workloads/Dev"
      )
    );
  }

  for (let i = 1; i <= process.env.WORKLOAD_TEST_ACCOUNTS || 0; i++) {
    accountsConfig.workloadAccounts.push(
      getWorkloadAccounts(
        `Test${i.toString().padStart(5, "0")}`,
        "Workloads/Test"
      )
    );
  }

  for (let i = 1; i <= process.env.WORKLOAD_PROD_ACCOUNTS || 0; i++) {
    accountsConfig.workloadAccounts.push(
      getWorkloadAccounts(
        `Prod${i.toString().padStart(5, "0")}`,
        "Workloads/Prod"
      )
    );
  }

  for (let i = 1; i <= process.env.WORKLOAD_SANDBOX_ACCOUNTS || 0; i++) {
    accountsConfig.workloadAccounts.push(
      getWorkloadAccounts(
        `Sandbox${i.toString().padStart(5, "0")}`,
        "Workloads/Sandbox"
      )
    );
  }

  console.log(accountsConfig);
  fs.writeFileSync(accountsConfigFilename, yaml.dump(accountsConfig), "utf8");
} catch (error) {
  console.error(error);
  process.exit(1);
}

function getWorkloadAccounts(name, ou) {
  return {
    name: name,
    description: name,
    email: `${process.env.EMAIL_ALIAS}+${process.env.ENVIRONMENT_NAME}-${
      process.env.AWS_DEFAULT_REGION
    }-${name.toLowerCase()}@${process.env.EMAIL_DOMAIN}`,
    organizationalUnit: ou,
  };
}
