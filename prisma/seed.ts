import bcrypt from "bcryptjs";
import { prisma } from "../src/common/prisma";
import { env } from "../src/config/env";
import { ROLE_NAMES } from "../src/common/permissions";
import { PLAN_KEYS } from "../src/common/plans";
import { provisionTenant } from "../src/common/tenant-provisioning";
import { DEFAULT_SETTINGS } from "../src/modules/system-settings/system-settings.service";
import { paymentsService } from "../src/modules/payments/payments.service";
import { transfersService } from "../src/modules/transfers/transfers.service";
import { incomingService } from "../src/modules/incoming/incoming.service";
import { approvalsService } from "../src/modules/approvals/approvals.service";
import { generateDocumentNumber } from "../src/common/id-generator";

const DEMO_PASSWORD = "Password123!";
const DEMO_DOMAIN = "treasurysystem.com.my";
const PLATFORM_ADMIN_EMAIL = `platform-admin@${DEMO_DOMAIN}`;

async function main() {
  console.log("Seeding platform admin (cross-tenant oversight account)...");
  const platformAdminPasswordHash = await bcrypt.hash(DEMO_PASSWORD, env.bcryptSaltRounds);
  await prisma.platformAdmin.upsert({
    where: { email: PLATFORM_ADMIN_EMAIL },
    create: { email: PLATFORM_ADMIN_EMAIL, name: "Platform Operations", passwordHash: platformAdminPasswordHash },
    update: {},
  });

  const alreadySeeded = await prisma.tenant.count();
  if (alreadySeeded > 0) {
    console.log("Tenant data already exists - skipping tenant/demo seed. Delete the DB and re-migrate to reseed.");
    return;
  }

  console.log("Provisioning the first tenant (TEST)...");
  const { tenant, roleIdByName } = await prisma.$transaction((tx) =>
    provisionTenant(tx, { slug: "TEST", name: "TEST Sdn Bhd", accountType: "TEAM", planKey: PLAN_KEYS.PRO_PLUS })
  );
  // Seeded demo tenant gets an active Pro+ subscription immediately (no
  // checkout) so the demo login shows the full product.
  await prisma.subscription.update({ where: { tenantId: tenant.id }, data: { status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
  const tenantId = tenant.id;
  const roleRecords = new Map(Array.from(roleIdByName.entries()).map(([name, id]) => [name, { id }]));

  console.log("Seeding currencies (global reference data)...");
  await prisma.currency.createMany({
    data: [
      { code: "MYR", name: "Malaysian Ringgit", symbol: "RM", isBase: true },
      { code: "USD", name: "US Dollar", symbol: "$" },
      { code: "SGD", name: "Singapore Dollar", symbol: "S$" },
    ],
  });

  console.log("Seeding users...");
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, env.bcryptSaltRounds);
  const users = {
    admin: await prisma.user.create({
      data: { tenantId, email: `admin@${DEMO_DOMAIN}`, name: "Ahmad Zulkifli", jobTitle: "Group IT & Systems Admin", passwordHash, roles: { create: [{ roleId: roleRecords.get(ROLE_NAMES.ADMIN)!.id }] } },
    }),
    maker: await prisma.user.create({
      data: { tenantId, email: `maker@${DEMO_DOMAIN}`, name: "Siti Nurhaliza Ismail", jobTitle: "Treasury Executive", passwordHash, roles: { create: [{ roleId: roleRecords.get(ROLE_NAMES.FINANCE_MAKER)!.id }] } },
    }),
    checker: await prisma.user.create({
      data: { tenantId, email: `checker@${DEMO_DOMAIN}`, name: "Rajesh Kumar", jobTitle: "Treasury Senior Executive", passwordHash, roles: { create: [{ roleId: roleRecords.get(ROLE_NAMES.FINANCE_CHECKER)!.id }] } },
    }),
    manager: await prisma.user.create({
      data: { tenantId, email: `manager@${DEMO_DOMAIN}`, name: "Tan Mei Ling", jobTitle: "Head of Treasury", passwordHash, roles: { create: [{ roleId: roleRecords.get(ROLE_NAMES.FINANCE_MANAGER)!.id }] } },
    }),
    viewer: await prisma.user.create({
      data: { tenantId, email: `viewer@${DEMO_DOMAIN}`, name: "Lim Wei Jian", jobTitle: "Finance Analyst", passwordHash, roles: { create: [{ roleId: roleRecords.get(ROLE_NAMES.VIEWER)!.id }] } },
    }),
  };

  console.log("Seeding banks...");
  const banks = {
    maybank: await prisma.bank.create({ data: { tenantId, name: "Maybank", swiftCode: "MBBEMYKL", country: "MY" } }),
    cimb: await prisma.bank.create({ data: { tenantId, name: "CIMB Bank", swiftCode: "CIBBMYKL", country: "MY" } }),
    publicBank: await prisma.bank.create({ data: { tenantId, name: "Public Bank", swiftCode: "PBBEMYKL", country: "MY" } }),
    rhb: await prisma.bank.create({ data: { tenantId, name: "RHB Bank", swiftCode: "RHBBMYKL", country: "MY" } }),
    hongLeong: await prisma.bank.create({ data: { tenantId, name: "Hong Leong Bank", swiftCode: "HLBBMYKL", country: "MY" } }),
  };

  console.log("Seeding bank accounts (including the shortfall/excess demo scenario)...");
  const now = new Date();
  const accounts = {
    // Bank A from the business requirement's worked example: below minimum balance.
    maybankOperating: await prisma.bankAccount.create({
      data: {
        tenantId, bankId: banks.maybank.id, accountName: "Maybank Operating Account", accountNumber: "1064-2200-1145", currencyCode: "MYR",
        accountType: "OPERATING", currentBalance: 80000, reservedAmount: 0, minimumBalance: 100000, targetBalance: 150000, lastBalanceAt: now,
      },
    }),
    // Bank B: healthy with excess cash, the natural source for the recommended transfer.
    cimbCollection: await prisma.bankAccount.create({
      data: {
        tenantId, bankId: banks.cimb.id, accountName: "CIMB Collection Account", accountNumber: "8006-1103-9922", currencyCode: "MYR",
        accountType: "COLLECTION", currentBalance: 500000, reservedAmount: 0, minimumBalance: 100000, targetBalance: 200000, lastBalanceAt: now,
      },
    }),
    publicDisbursement: await prisma.bankAccount.create({
      data: {
        tenantId, bankId: banks.publicBank.id, accountName: "Public Bank Disbursement Account", accountNumber: "3192-0087-6610", currencyCode: "MYR",
        accountType: "DISBURSEMENT", currentBalance: 268000, reservedAmount: 15000, minimumBalance: 50000, targetBalance: 100000, lastBalanceAt: now,
      },
    }),
    rhbReserve: await prisma.bankAccount.create({
      data: {
        tenantId, bankId: banks.rhb.id, accountName: "RHB Reserve Account", accountNumber: "2140-5561-0033", currencyCode: "MYR",
        accountType: "RESERVE", currentBalance: 118000, reservedAmount: 0, minimumBalance: 100000, targetBalance: 120000, lastBalanceAt: now,
      },
    }),
    hongLeongUsd: await prisma.bankAccount.create({
      data: {
        tenantId, bankId: banks.hongLeong.id, accountName: "Hong Leong USD Trade Account", accountNumber: "0177-4402-8815", currencyCode: "USD",
        accountType: "OPERATING", currentBalance: 42500, reservedAmount: 2500, minimumBalance: 20000, targetBalance: 60000, lastBalanceAt: now,
      },
    }),
    maybankSgd: await prisma.bankAccount.create({
      data: {
        tenantId, bankId: banks.maybank.id, accountName: "Maybank Singapore Collection", accountNumber: "7002-8814-0091", currencyCode: "SGD",
        accountType: "COLLECTION", currentBalance: 31500, reservedAmount: 0, minimumBalance: 10000, targetBalance: 40000, lastBalanceAt: now,
      },
    }),
  };

  console.log("Seeding approval rules...");
  await prisma.approvalRule.createMany({
    data: [
      { tenantId, entityType: "PAYMENT", minAmount: 0, maxAmount: 50000, requiredLevels: 1, requiredRoleLevel1: ROLE_NAMES.FINANCE_CHECKER, priority: 10 },
      { tenantId, entityType: "PAYMENT", minAmount: 50000, requiredLevels: 2, requiredRoleLevel1: ROLE_NAMES.FINANCE_CHECKER, requiredRoleLevel2: ROLE_NAMES.FINANCE_MANAGER, priority: 20 },
      { tenantId, entityType: "TRANSFER", minAmount: 0, maxAmount: 100000, requiredLevels: 1, requiredRoleLevel1: ROLE_NAMES.FINANCE_CHECKER, priority: 10 },
      { tenantId, entityType: "TRANSFER", minAmount: 100000, requiredLevels: 2, requiredRoleLevel1: ROLE_NAMES.FINANCE_CHECKER, requiredRoleLevel2: ROLE_NAMES.FINANCE_MANAGER, priority: 20 },
    ],
  });

  console.log("Seeding system settings...");
  for (const [key, { value, description }] of Object.entries(DEFAULT_SETTINGS)) {
    const resolvedValue = key === "system.company_name" ? tenant.name : value;
    await prisma.systemSetting.create({ data: { tenantId, key, value: resolvedValue, description, updatedById: users.admin.id } });
  }

  console.log("Seeding 35-day balance history...");
  for (const account of Object.values(accounts)) {
    const end = Number(account.currentBalance);
    let walking = end * 0.92; // start slightly lower 35 days ago, drift up to today's value
    const step = (end - walking) / 34;
    for (let daysAgo = 35; daysAgo >= 1; daysAgo--) {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setDate(date.getDate() - daysAgo);
      const jitter = (Math.random() - 0.5) * end * 0.015;
      const closing = daysAgo === 1 ? end : Math.max(0, walking + jitter);
      await prisma.accountBalance.create({
        data: {
          tenantId, accountId: account.id, currencyCode: account.currencyCode, balanceDate: date,
          openingBalance: closing, closingBalance: closing, availableBalance: closing - Number(account.reservedAmount),
          source: "IMPORT",
        },
      });
      walking += step;
    }
  }

  console.log("Seeding historical (already settled) transactions...");
  // Processed payments - beneficiary payouts already completed in prior weeks.
  const settledPayments = [
    { account: accounts.publicDisbursement, name: "Petronas Dagangan Bhd", benAcc: "5141-0022-3390", benBank: "Maybank", amount: 42000, daysAgo: 12, desc: "Fuel & utilities - March" },
    { account: accounts.maybankOperating, name: "Tenaga Nasional Bhd", benAcc: "1234-5678-9012", benBank: "CIMB Bank", amount: 8600, daysAgo: 20, desc: "Electricity bill" },
    { account: accounts.rhbReserve, name: "EPF (KWSP)", benAcc: "6002-1188-4470", benBank: "Maybank", amount: 15400, daysAgo: 6, desc: "Statutory contribution" },
  ];
  for (const p of settledPayments) {
    const paymentNumber = await generateDocumentNumber(tenantId, "PMT");
    const paymentDate = daysAgoDate(p.daysAgo);
    const payment = await prisma.payment.create({
      data: {
        tenantId, paymentNumber, beneficiaryName: p.name, beneficiaryAccount: p.benAcc, beneficiaryBank: p.benBank,
        amount: p.amount, currencyCode: p.account.currencyCode, sourceAccountId: p.account.id, paymentDate, description: p.desc,
        status: "PROCESSED", requestedById: users.maker.id, createdAt: paymentDate,
      },
    });
    await prisma.transaction.create({
      data: { tenantId, accountId: p.account.id, currencyCode: p.account.currencyCode, type: "PAYMENT_OUT", amount: p.amount, reference: paymentNumber, description: p.desc, transactionDate: paymentDate, relatedPaymentId: payment.id },
    });
  }

  // A completed inter-bank transfer between accounts not part of the featured shortfall scenario.
  const completedTransferNumber = await generateDocumentNumber(tenantId, "TRF");
  const transferDate = daysAgoDate(9);
  const completedTransfer = await prisma.transfer.create({
    data: {
      tenantId, transferNumber: completedTransferNumber, sourceAccountId: accounts.hongLeongUsd.id, destinationAccountId: accounts.publicDisbursement.id,
      amount: 5000, currencyCode: "USD", reason: "Quarterly liquidity rebalancing", transferDate, status: "COMPLETED", requestedById: users.maker.id, createdAt: transferDate,
    },
  });
  await prisma.transaction.createMany({
    data: [
      { tenantId, accountId: accounts.hongLeongUsd.id, currencyCode: "USD", type: "TRANSFER_OUT", amount: 5000, reference: completedTransferNumber, description: "Quarterly liquidity rebalancing", transactionDate: transferDate, relatedTransferId: completedTransfer.id },
      { tenantId, accountId: accounts.publicDisbursement.id, currencyCode: "USD", type: "TRANSFER_IN", amount: 5000, reference: completedTransferNumber, description: "Quarterly liquidity rebalancing", transactionDate: transferDate, relatedTransferId: completedTransfer.id },
    ],
  });
  const completedApproval = await prisma.approvalRequest.create({
    data: { tenantId, entityType: "TRANSFER", transferId: completedTransfer.id, requestedById: users.maker.id, amount: 5000, currencyCode: "USD", status: "APPROVED", currentLevel: 1, requiredLevels: 1, createdAt: transferDate },
  });
  await prisma.approvalAction.create({ data: { tenantId, approvalRequestId: completedApproval.id, level: 1, actorId: users.checker.id, action: "APPROVE", comment: "Confirmed against liquidity plan.", actedAt: daysAgoDate(9) } });

  // Received / reconciled incoming transactions (historical).
  await prisma.incomingTransaction.create({
    data: { tenantId, reference: "INC-2026-000041", sourceName: "Sunway Retail Sdn Bhd", amount: 96000, currencyCode: "MYR", destinationAccountId: accounts.cimbCollection.id, valueDate: daysAgoDate(15), description: "Trade receivable - Invoice INV-4471", status: "RECONCILED" },
  });
  await prisma.incomingTransaction.create({
    data: { tenantId, reference: "INC-2026-000052", sourceName: "AEON Credit Service", amount: 54200, currencyCode: "MYR", destinationAccountId: accounts.cimbCollection.id, valueDate: daysAgoDate(4), description: "Trade receivable - Invoice INV-4502", status: "RECEIVED" },
  });

  console.log("Seeding cash forecast (manual entries)...");
  await prisma.cashForecast.createMany({
    data: [
      { tenantId, currencyCode: "MYR", forecastDate: daysAheadDate(10), category: "OUTFLOW", sourceType: "MANUAL", amount: 60000, confidence: "HIGH", description: "Corporate income tax instalment (LHDN)", accountId: accounts.maybankOperating.id },
      { tenantId, currencyCode: "MYR", forecastDate: daysAheadDate(18), category: "INFLOW", sourceType: "MANUAL", amount: 220000, confidence: "MEDIUM", description: "Expected receivable - Genting Malaysia Bhd contract milestone", accountId: accounts.cimbCollection.id },
      { tenantId, currencyCode: "MYR", forecastDate: daysAheadDate(25), category: "OUTFLOW", sourceType: "MANUAL", amount: 45000, confidence: "MEDIUM", description: "Payroll & EPF/SOCSO - April", accountId: accounts.publicDisbursement.id },
      { tenantId, currencyCode: "USD", forecastDate: daysAheadDate(14), category: "OUTFLOW", sourceType: "MANUAL", amount: 12000, confidence: "LOW", description: "Import duty - overseas supplier", accountId: accounts.hongLeongUsd.id },
    ],
  });

  console.log("Seeding live workflow demos (create/submit/approve via real services)...");

  // 1) An EXPECTED incoming transaction, left open so it appears in the pipeline & forecast.
  await incomingService.create(
    tenantId,
    { sourceName: "Malaysia Airports Holdings Bhd", amount: 138000, currencyCode: "MYR", destinationAccountId: accounts.cimbCollection.id, valueDate: isoDaysAhead(7), description: "Trade receivable - Invoice INV-4599" },
    users.maker.id
  );

  // 2) A DRAFT payment awaiting the maker's review before submission.
  await paymentsService.create(
    tenantId,
    { beneficiaryName: "IJM Corporation Bhd", beneficiaryAccount: "1420-9981-0027", beneficiaryBank: "CIMB Bank", amount: 27500, currencyCode: "MYR", sourceAccountId: accounts.publicDisbursement.id, paymentDate: isoDaysAhead(3), description: "Progress claim - office fit-out" },
    users.maker.id
  );

  // 3) A high-value payment that needs 2-level approval: submitted, level 1 (Checker)
  //    already approved, now sitting with the Finance Manager - a ready-to-try demo.
  const bigPayment = await paymentsService.create(
    tenantId,
    { beneficiaryName: "Sime Darby Property Bhd", beneficiaryAccount: "8871-2200-5541", beneficiaryBank: "Public Bank", amount: 92000, currencyCode: "MYR", sourceAccountId: accounts.rhbReserve.id, paymentDate: isoDaysAhead(2), description: "Progress billing - HQ renovation" },
    users.maker.id
  );
  const submittedBigPayment = await paymentsService.submit(tenantId, bigPayment.id, users.maker.id);
  const bigPaymentApprovalId = submittedBigPayment.approvalRequests[0].id;
  await approvalsService.act(tenantId, bigPaymentApprovalId, { id: users.checker.id, roles: [ROLE_NAMES.FINANCE_CHECKER] }, "APPROVE", "Beneficiary and invoice verified.");

  // 4) A smaller payment pending a single Checker approval - ready to approve/reject in the demo.
  const smallPayment = await paymentsService.create(
    tenantId,
    { beneficiaryName: "Grab Malaysia Sdn Bhd", beneficiaryAccount: "5502-1187-0034", beneficiaryBank: "Maybank", amount: 3200, currencyCode: "MYR", sourceAccountId: accounts.maybankOperating.id, paymentDate: isoDaysAhead(1), description: "Corporate travel - March" },
    users.maker.id
  );
  await paymentsService.submit(tenantId, smallPayment.id, users.maker.id);

  // 5) The featured shortfall scenario: a DRAFT transfer pre-filled from the system's
  //    recommendation (Bank A below minimum, Bank B has excess), left for the maker to
  //    review/adjust and submit - exactly the workflow described in the requirements.
  const recommendations = await transfersService.getRecommendations(tenantId);
  const featured = recommendations.find((r) => r.destinationAccountId === accounts.maybankOperating.id) ?? recommendations[0];
  if (featured) {
    await transfersService.create(
      tenantId,
      {
        sourceAccountId: featured.sourceAccountId,
        destinationAccountId: featured.destinationAccountId,
        amount: featured.amount,
        currencyCode: featured.currencyCode,
        reason: featured.reason,
        transferDate: isoDaysAhead(0),
        suggestedAmount: featured.amount,
        isSystemRecommended: true,
      },
      users.maker.id
    );
  }

  console.log("\nSeed complete.");
  console.log("Tenant: %s (slug: %s) - plan: Pro+", tenant.name, tenant.slug);
  console.log("Demo accounts (all use password: %s)", DEMO_PASSWORD);
  console.log("  admin@%s    Admin", DEMO_DOMAIN);
  console.log("  maker@%s    Finance Maker", DEMO_DOMAIN);
  console.log("  checker@%s  Finance Checker", DEMO_DOMAIN);
  console.log("  manager@%s  Finance Manager  <- try approving the pending payment (level 2)", DEMO_DOMAIN);
  console.log("  viewer@%s   Viewer", DEMO_DOMAIN);
  console.log("\nPlatform admin (cross-tenant oversight, sign in at /platform/login):");
  console.log("  %s   password: %s", PLATFORM_ADMIN_EMAIL, DEMO_PASSWORD);
}

function daysAgoDate(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}
function daysAheadDate(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}
function isoDaysAhead(days: number): string {
  return daysAheadDate(days).toISOString().slice(0, 10);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
