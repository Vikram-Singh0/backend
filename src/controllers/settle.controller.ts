import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { updateGroupBalanceForParticipants } from "../services/split.service";
import { z } from "zod";
import {
  checkAccountBalance,
  convertUsdToXLM,
  createSerializedTransaction,
  submitTransaction,
  getTransactionDetails,
  checkAccountExists,
} from "../utils/stellar";
import { logger } from "../utils/logger";

const settleDebtSchemaCreate = z.object({
  groupId: z.string().min(1, "Group id is required"),
  settleWithId: z.string().optional(),
  address: z.string().min(1, "Address is required"),
  selectedTokenId: z.string().optional(),
  selectedChainId: z.string().optional(),
  expenseId: z.string().optional(),
});

export const settleDebtCreateTransaction = async (
  req: Request,
  res: Response
) => {
  logger.info({ body: req.body, userId: req.user?.id }, "[settleDebtCreateTransaction] called");
  logger.info({ secretKey: process.env.SECRET_KEY ? `****${process.env.SECRET_KEY.slice(-4)}` : 'undefined' }, "[settleDebtCreateTransaction] env.SECRET_KEY");
  logger.info({ headers: req.headers }, "[settleDebtCreateTransaction] Request headers");
  
  const result = settleDebtSchemaCreate.safeParse(req.body);

  if (!result.success) {
    logger.warn({ issues: result.error.issues }, "[settleDebtCreateTransaction] invalid input");
    res.status(400).json({ error: result.error.issues });
    return;
  }

  const { groupId, address, settleWithId, selectedTokenId, selectedChainId, expenseId } =
    { ...result.data, ...req.body };

  logger.info({ groupId, address, settleWithId, selectedTokenId, selectedChainId, expenseId }, "[settleDebtCreateTransaction] Parsed data");

  const userId = req.user!.id;

  try {
    // Check if tokens are initialized in database
    const tokenCount = await prisma.token.count();
    logger.info({ tokenCount }, "[settleDebtCreateTransaction] Token count in database");
    
    if (tokenCount === 0) {
      logger.warn("No tokens found in database, initializing...");
      // Import and call initialization function
      const { initializeMultiChainSystem, initializeChainsAndTokens } = await import("../services/initialize-multichain");
      await initializeMultiChainSystem();
      await initializeChainsAndTokens();
      logger.info("Tokens initialized in database");
    }

    logger.info({ address }, "[settleDebtCreateTransaction] Checking account existence");
    const accountExists = await checkAccountExists(address);
    logger.info({ address, accountExists }, "[settleDebtCreateTransaction] Account existence result");

    if (!accountExists) {
      logger.warn({ address }, "[settleDebtCreateTransaction] Account does not exist");
      res.status(400).json({ error: "Account does not exist" });
      return;
    }

    logger.info({ userId, groupId, settleWithId }, "[settleDebtCreateTransaction] Fetching group balances");
    const balances = await prisma.groupBalance.findMany({
      where: {
        AND: [
          { userId: userId },
          { groupId: groupId },
          ...(settleWithId ? [{ firendId: settleWithId }] : []),
        ],
      },
      include: {
        friend: {
          select: {
            id: true,
            name: true,
            stellarAccount: true,
            chainAccounts: {
              where: { chainId: 'stellar' },
              select: { address: true }
            }
          },
        },
      },
    });
    logger.info({ balances }, "[settleDebtCreateTransaction] Group balances fetched");

    const toPay = balances.filter((balance) => balance.amount > 0);
    logger.info({ toPay }, "[settleDebtCreateTransaction] Filtered balances to pay");

    if (toPay.length === 0) {
      logger.warn({ userId, groupId }, "[settleDebtCreateTransaction] No balances to pay");
      res.status(400).json({ error: "No balances to pay" });
      return;
    }

    // --- Resolver Enforcement Logic ---
    let allowedTokenIds: string[] = [];
    let allowedChainIds: string[] = [];
    let resolverLevel = "none";

    // 1. Expense-level resolver (if expenseId provided)
    if (expenseId) {
      const expense = await prisma.expense.findUnique({
        where: { id: expenseId },
        select: { acceptedTokenIds: true }
      });
      logger.info({ expense }, "[settleDebtCreateTransaction] Expense-level resolver");
      if (expense && expense.acceptedTokenIds && expense.acceptedTokenIds.length > 0) {
        allowedTokenIds = expense.acceptedTokenIds;
        resolverLevel = "expense";
      }
    }

    // 2. Group-level resolver
    if (!allowedTokenIds.length) {
      const groupTokens = await prisma.groupAcceptedToken.findMany({
        where: { groupId },
        select: { tokenId: true, chainId: true }
      });
      logger.info({ groupTokens }, "[settleDebtCreateTransaction] Group-level resolver");
      if (groupTokens.length > 0) {
        allowedTokenIds = groupTokens.map(t => t.tokenId);
        allowedChainIds = groupTokens.map(t => t.chainId);
        resolverLevel = "group";
      }
    }

    // 3. User-level resolver
    if (!allowedTokenIds.length && settleWithId) {
      const userTokens = await prisma.userAcceptedToken.findMany({
        where: { userId: settleWithId },
        select: { tokenId: true, chainId: true }
      });
      logger.info({ userTokens }, "[settleDebtCreateTransaction] User-level resolver");
      if (userTokens.length > 0) {
        allowedTokenIds = userTokens.map(t => t.tokenId);
        allowedChainIds = userTokens.map(t => t.chainId);
        resolverLevel = "user";
      }
    }

    // If a resolver is set, enforce it
    if (allowedTokenIds.length > 0) {
      if (!selectedTokenId || !allowedTokenIds.includes(selectedTokenId)) {
        logger.warn({ selectedTokenId, allowedTokenIds, resolverLevel }, "[settleDebtCreateTransaction] Resolver enforcement failed (token)");
        return res.status(400).json({
          error: `You must settle using the allowed resolver token(s) (${resolverLevel} level). Allowed token IDs: ${allowedTokenIds.join(", ")}`
        });
      }
      // Optionally, also check chainId if needed
      if (allowedChainIds.length > 0 && selectedChainId && !allowedChainIds.includes(selectedChainId)) {
        logger.warn({ selectedChainId, allowedChainIds, resolverLevel }, "[settleDebtCreateTransaction] Resolver enforcement failed (chain)");
        return res.status(400).json({
          error: `You must settle using the allowed resolver chain(s) (${resolverLevel} level). Allowed chain IDs: ${allowedChainIds.join(", ")}`
        });
      }
    }
    // --- End Resolver Enforcement ---

    // Determine settlement token based on selection or preferences
    let settlementToken;
    let settlementChain;

    if (selectedTokenId && selectedChainId) {
      // Use selected token if provided
      logger.info({ selectedTokenId, selectedChainId }, "[settleDebtCreateTransaction] Looking for selected token");
      settlementToken = await prisma.token.findUnique({
        where: { id: selectedTokenId },
        include: { chain: true },
      });
      logger.info({ settlementToken }, "[settleDebtCreateTransaction] Selected token result");
      if (!settlementToken) {
        logger.error({ selectedTokenId }, "[settleDebtCreateTransaction] Selected token not found");
        // Let's also check what tokens exist for this chain
        const availableTokens = await prisma.token.findMany({
          where: { chainId: selectedChainId },
          select: { id: true, symbol: true, name: true }
        });
        logger.info({ availableTokens, selectedChainId }, "[settleDebtCreateTransaction] Available tokens for chain");
        
        // For Stellar chain, try to find XLM token by symbol if ID not found
        if (selectedChainId === "stellar" && selectedTokenId === "xlm") {
          logger.info("Trying to find XLM token by symbol");
          const xlmToken = await prisma.token.findFirst({
            where: { 
              chainId: "stellar",
              symbol: "XLM"
            },
            include: { chain: true },
          });
          if (xlmToken) {
            logger.info({ xlmToken }, "[settleDebtCreateTransaction] Found XLM token by symbol");
            settlementToken = xlmToken;
            settlementChain = xlmToken.chain;
          } else {
            res.status(404).json({ error: "Selected token not found" });
            return;
          }
        } else {
          res.status(404).json({ error: "Selected token not found" });
          return;
        }
      } else {
        settlementChain = settlementToken.chain;
      }
    } else {
      // Try to find a token accepted by all parties
      let acceptableTokens: any = [];

      // If settling with specific friend
      if (settleWithId) {
        // Get friend's accepted tokens
        const friendAcceptedTokens = await prisma.userAcceptedToken.findMany({
          where: { userId: settleWithId },
          include: { token: true, chain: true },
        });

        if (friendAcceptedTokens.length > 0) {
          acceptableTokens = friendAcceptedTokens.map((t) => ({
            token: t.token,
            chain: t.chain,
            isDefault: t.isDefault,
          }));
        }
      } else {
        // Get group's accepted tokens
        const groupAcceptedTokens = await prisma.groupAcceptedToken.findMany({
          where: { groupId },
          include: { token: true, chain: true },
        });
        logger.info({ groupAcceptedTokens }, "[settleDebtCreateTransaction] Group accepted tokens");
        if (groupAcceptedTokens.length > 0) {
          acceptableTokens = groupAcceptedTokens.map((t) => ({
            token: t.token,
            chain: t.chain,
            isDefault: t.isDefault,
          }));
        }
      }

      // If no tokens found, use Stellar XLM as default
      if (acceptableTokens.length === 0) {
        // Get Stellar chain and XLM token
        const stellarChain = await prisma.supportedChain.findFirst({
          where: { id: "stellar" },
        });

        const xlmToken = await prisma.token.findFirst({
          where: {
            chainId: "stellar",
            symbol: "XLM",
          },
        });
        logger.info({ stellarChain, xlmToken }, "[settleDebtCreateTransaction] Defaulting to XLM");
        if (!stellarChain || !xlmToken) {
          logger.error({}, "[settleDebtCreateTransaction] Default settlement token not configured");
          res.status(500).json({ error: "Default settlement token not configured" });
          return;
        }

        settlementToken = xlmToken;
        settlementChain = stellarChain;
      } else {
        // Find default token or use first one
        const defaultToken = acceptableTokens.find((t: any) => t.isDefault);

        if (defaultToken) {
          settlementToken = defaultToken.token;
          settlementChain = defaultToken.chain;
        } else {
          settlementToken = acceptableTokens[0].token;
          settlementChain = acceptableTokens[0].chain;
        }
        logger.info({ settlementToken, settlementChain }, "[settleDebtCreateTransaction] Using resolved token/chain");
      }
    }

    // Validate all friends have accounts on the selected chain
    for (const balance of toPay) {
      const friendStellarAddress =
        balance.friend.chainAccounts && balance.friend.chainAccounts.length > 0
          ? balance.friend.chainAccounts[0].address
          : balance.friend.stellarAccount;
      logger.info({ friendId: balance.friend.id, chainAccounts: balance.friend.chainAccounts, legacy: balance.friend.stellarAccount, using: friendStellarAddress }, "[settleDebtCreateTransaction] Checking friend account");
      if (!friendStellarAddress && settlementChain.id === "stellar") {
        logger.warn({ friendId: balance.friend.id }, "[settleDebtCreateTransaction] Missing Stellar account for friend");
        res.status(400).json({
          error: `Friend ${balance.friend.name} has no Stellar account`,
        });
        return;
      }

      // If using other chains, check the corresponding account
      if (settlementChain.id !== "stellar") {
        const friendChainAccount = await prisma.chainAccount.findFirst({
          where: {
            userId: balance.firendId,
            chainId: settlementChain.id,
          },
        });
        logger.info({ friendId: balance.friend.id, friendChainAccount }, "[settleDebtCreateTransaction] Checking friend chain account");
        if (!friendChainAccount) {
          logger.warn({ friendId: balance.friend.id, chainId: settlementChain.id }, "[settleDebtCreateTransaction] Missing chain account for friend");
          res.status(400).json({
            error: `Friend ${balance.friend.name} has no ${settlementChain.name} account`,
          });
          return;
        }
      }
    }

    const toPayInSettlementToken = await Promise.all(
      toPay.map(async (balance) => {
        let convertedAmount: string = "0";
        let tokenAmount: number = 0;
        try {
          if (balance.currency === "USD" && settlementToken.symbol === "XLM") {
          // Use existing conversion for USD to XLM
            convertedAmount = await convertUsdToXLM(balance.amount);
            tokenAmount = Number(convertedAmount);
          } else if (balance.currency === "USD") {
          // TODO: Implement conversion from USD to other tokens
          // For now, just use a 1:1 conversion
            tokenAmount = balance.amount;
            convertedAmount = balance.amount.toString();
          } else {
          // Same token, no conversion needed
            tokenAmount = balance.amount;
            convertedAmount = balance.amount.toString();
          }
        } catch (err) {
          logger.error({ err, balance }, "[settleDebtCreateTransaction] Error converting amount");
          throw err;
        }
        const friendStellarAddress =
          balance.friend.chainAccounts && balance.friend.chainAccounts.length > 0
            ? balance.friend.chainAccounts[0].address
            : balance.friend.stellarAccount;
        logger.info({ friendId: balance.friend.id, address: friendStellarAddress, amount: convertedAmount, tokenAmount }, "[settleDebtCreateTransaction] Payment resolved");
        return {
          address: friendStellarAddress || "",
          amount: convertedAmount.toString(),
          friendId: balance.firendId,
          tokenAmount: tokenAmount,
        };
      })
    );

    // For non-Stellar chains, get the proper recipient addresses
    if (settlementChain.id !== "stellar") {
      for (let i = 0; i < toPayInSettlementToken.length; i++) {
        const payment = toPayInSettlementToken[i];
        const friendChainAccount = await prisma.chainAccount.findFirst({
          where: {
            userId: payment.friendId,
            chainId: settlementChain.id,
          },
        });
        logger.info({ friendId: payment.friendId, friendChainAccount }, "[settleDebtCreateTransaction] Non-stellar payment address resolved");
        if (friendChainAccount) {
          toPayInSettlementToken[i].address = friendChainAccount.address;
        }
      }
    }

    const totalAmount = toPayInSettlementToken.reduce(
      (acc, balance) => acc + Number(balance.tokenAmount),
      0
    );
    logger.info({ totalAmount, toPayInSettlementToken }, "[settleDebtCreateTransaction] Total amount to pay");

    // Check if user has enough balance for settlement
    logger.info({ address }, "[settleDebtCreateTransaction] Checking account balance");
    const accountBalance = await checkAccountBalance(address);
    logger.info({ accountBalance }, "[settleDebtCreateTransaction] Account balance fetched");

    // This is Stellar-specific, modify for other chains
    const tokenBalance =
      settlementChain.id === "stellar"
        ? Number(
            accountBalance.find((balance) => balance.asset_type === "native")
              ?.balance || 0
          )
        : 0;
    logger.info({ tokenBalance }, "[settleDebtCreateTransaction] Token balance resolved");

    if (tokenBalance < totalAmount && settlementChain.id === "stellar") {
      logger.warn({ tokenBalance, totalAmount }, "[settleDebtCreateTransaction] Insufficient balance");
      res.status(400).json({ error: "Insufficient balance" });
      return;
    }

    // Create transaction
    let transaction;
    try {
      if (settlementChain.id === "stellar") {
        logger.info({ address, payments: toPayInSettlementToken.map(b => ({ address: b.address, amount: b.amount })) }, "[settleDebtCreateTransaction] Creating serialized transaction");
        transaction = await createSerializedTransaction(
          address,
          toPayInSettlementToken.map((balance) => ({
            address: balance.address,
            amount: balance.amount,
          }))
        );
        logger.info({ transaction }, "[settleDebtCreateTransaction] Serialized transaction created");
      } else {
        logger.warn({ settlementChain }, "[settleDebtCreateTransaction] Settlement on this chain not yet implemented");
        res
          .status(400)
          .json({ error: "Settlement on this chain not yet implemented" });
        return;
      }
    } catch (err) {
      logger.error({ err }, "[settleDebtCreateTransaction] Error creating transaction");
      throw err;
    }

    // Store the transaction details in the database
    let settlementTransaction;
    try {
      settlementTransaction = await prisma.settlementTransaction.create({
        data: {
          userId: userId,
          groupId: groupId,
          serializedTx: transaction.serializedTx,
          settleWithId: settleWithId,
          status: "PENDING",
          chainId: settlementChain.id,
          tokenId: settlementToken.id,
          settlementItems: {
            create: toPayInSettlementToken.map((item) => ({
              userId: userId,
              friendId: item.friendId,
              amount: item.tokenAmount,
              currency: settlementToken.symbol,
            })),
          },
        },
      });
      logger.info({ settlementTransaction }, "[settleDebtCreateTransaction] Settlement transaction stored in DB");
    } catch (err) {
      logger.error({ err }, "[settleDebtCreateTransaction] Error storing settlement transaction in DB");
      throw err;
    }

    logger.info({ toPayInSettlementToken }, "[settleDebtCreateTransaction] success");

    res.json({
      serializedTx: transaction.serializedTx,
      txHash: transaction.txHash,
      settlementId: settlementTransaction.id,
      tokenSymbol: settlementToken.symbol,
      chainName: settlementChain.name,
    });
  } catch (error) {
    logger.error({ error, stack: (error as any)?.stack }, "[settleDebtCreateTransaction] Unhandled error");
    res.status(500).json({ error: "Failed to create settlement transaction" });
  }
};

const settleDebtSchemaSubmit = z.object({
  groupId: z.string().min(1, "Group id is required"),
  signedTx: z.string().min(1, "signedTx is required"),
  settlementId: z.string().min(1, "settlementId is required"),
  settleWithId: z.string().optional(),
});

export const settleDebtSubmitTransaction = async (
  req: Request,
  res: Response
) => {
  const result = settleDebtSchemaSubmit.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({ error: result.error.issues });
    return;
  }

  const { signedTx, groupId, settlementId, settleWithId } = result.data;
  const userId = req.user!.id;

  try {
    // Get the stored settlement transaction
    const settlementTransaction = await prisma.settlementTransaction.findFirst({
      where: {
        id: settlementId,
        userId: userId,
        groupId: groupId,
        settleWithId: settleWithId || null,
        status: "PENDING",
      },
      include: {
        settlementItems: {
          include: {
            friend: {
              select: {
                id: true,
                stellarAccount: true,
                chainAccounts: {
                  where: { chainId: 'stellar' },
                  select: { address: true }
                }
              },
            },
          },
        },
      },
    });

    if (!settlementTransaction) {
      res.status(404).json({ error: "Settlement transaction not found" });
      return;
    }

    // Verify the transaction is the same by comparing transaction details
    const txDetails = await getTransactionDetails(signedTx);

    // Extract payment operations from the signed transaction
    const paymentOperations = txDetails.operations.filter(
      (op: any) => op.type === "payment" && op.asset_type === "native"
    );

    // Verify each payment in the transaction matches a settlement item
    let isValid = true;

    // Check that each payment in the transaction matches a settlement item
    for (const operation of paymentOperations) {
      const recipient = operation.to;
      const amount = parseFloat(operation.amount || "0");

      // Find the matching settlement item
      const matchingItem = settlementTransaction.settlementItems.find(
        (item) => {
          const friendStellarAddress =
            item.friend.chainAccounts && item.friend.chainAccounts.length > 0
              ? item.friend.chainAccounts[0].address
              : item.friend.stellarAccount;
          return (
            friendStellarAddress === recipient &&
          Math.abs(item.amount - amount) < 0.00001 // Account for floating point precision
          );
        }
      );

      if (!matchingItem) {
        isValid = false;
        break;
      }
    }

    // Also check that every settlement item has a matching payment operation
    if (
      isValid &&
      paymentOperations.length !== settlementTransaction.settlementItems.length
    ) {
      isValid = false;
    }

    if (!isValid) {
      // Update the settlement status to FAILED
      await prisma.settlementTransaction.update({
        where: { id: settlementId },
        data: { status: "FAILED" },
      });

      res.status(400).json({
        error: "The signed transaction does not match the original settlement",
      });
      return;
    }

    // Submit the transaction to the Stellar network
    const submitTransactionResponse = await submitTransaction(signedTx);

    if (!submitTransactionResponse.successful) {
      // Update the settlement status to FAILED
      await prisma.settlementTransaction.update({
        where: { id: settlementId },
        data: { status: "FAILED" },
      });

      res.status(400).json({ error: "Transaction failed on Stellar network" });
      return;
    }

    // Update the settlement status to COMPLETED
    await prisma.settlementTransaction.update({
      where: { id: settlementId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        transactionHash: submitTransactionResponse.hash,
      },
    });

    // Update group balances based on the settlement items
    const participants = settlementTransaction.settlementItems.map((item) => ({
      userId: item.friendId,
      amount: item.amount,
      currency: item.currency,
    }));

    await updateGroupBalanceForParticipants(participants, userId, groupId);

    res.json({
      hash: submitTransactionResponse.hash,
      settlementId: settlementTransaction.id,
    });
  } catch (error: any) {
    console.error(
      "Settlement transaction submission error:",
      error.message,
      error?.response?.data,
      error?.response?.data?.extras
    );

    // Update the settlement status to FAILED if it exists
    if (settlementId) {
      await prisma.settlementTransaction
        .update({
          where: { id: settlementId },
          data: { status: "FAILED" },
        })
        .catch(() => {}); // Ignore errors in updating status
    }

    res.status(500).json({ error: "Failed to submit transaction" });
  }
};

export const getSettlementTokenOptions = async (
  req: Request,
  res: Response
) => {
  try {
    const { groupId, settleWithId } = req.query;
    const userId = req.user!.id;

    if (!groupId) {
      res.status(400).json({ error: "Group ID is required" });
      return;
    }

    // Find tokens accepted by all parties
    let tokensToReturn = [];

    // Get group's accepted tokens
    const groupAcceptedTokens = await prisma.$queryRaw`
      SELECT gt.*, t.name, t.symbol, t.decimals, t.type, t.logoUrl, 
             sc.name as chainName, sc.currency as chainCurrency, sc.logoUrl as chainLogoUrl
      FROM "GroupAcceptedToken" gt
      JOIN "Token" t ON gt."tokenId" = t.id
      JOIN "SupportedChain" sc ON gt."chainId" = sc.id
      WHERE gt."groupId" = ${groupId}
    `;

    if (Array.isArray(groupAcceptedTokens) && groupAcceptedTokens.length > 0) {
      tokensToReturn.push({
        source: "Group",
        tokens: groupAcceptedTokens,
      });
    }

    // If settling with specific user, add their tokens
    if (settleWithId) {
      const friendAcceptedTokens = await prisma.$queryRaw`
        SELECT ut.*, t.name, t.symbol, t.decimals, t.type, t.logoUrl, 
               sc.name as chainName, sc.currency as chainCurrency, sc.logoUrl as chainLogoUrl
        FROM "UserAcceptedToken" ut
        JOIN "Token" t ON ut."tokenId" = t.id
        JOIN "SupportedChain" sc ON ut."chainId" = sc.id
        WHERE ut."userId" = ${settleWithId}
      `;

      if (
        Array.isArray(friendAcceptedTokens) &&
        friendAcceptedTokens.length > 0
      ) {
        tokensToReturn.push({
          source: "Friend",
          tokens: friendAcceptedTokens,
        });
      }
    }

    // Add current user's tokens
    const userAcceptedTokens = await prisma.$queryRaw`
      SELECT ut.*, t.name, t.symbol, t.decimals, t.type, t.logoUrl, 
             sc.name as chainName, sc.currency as chainCurrency, sc.logoUrl as chainLogoUrl
      FROM "UserAcceptedToken" ut
      JOIN "Token" t ON ut."tokenId" = t.id
      JOIN "SupportedChain" sc ON ut."chainId" = sc.id
      WHERE ut."userId" = ${userId}
    `;

    if (Array.isArray(userAcceptedTokens) && userAcceptedTokens.length > 0) {
      tokensToReturn.push({
        source: "Your Preferences",
        tokens: userAcceptedTokens,
      });
    }

    // If no tokens found, add default Stellar XLM token
    if (tokensToReturn.length === 0) {
      const defaultTokens = await prisma.$queryRaw`
        SELECT t.id as "tokenId", t.name, t.symbol, t.decimals, t.type, t.logoUrl, 
               sc.id as "chainId", sc.name as chainName, sc.currency as chainCurrency, sc.logoUrl as chainLogoUrl,
               true as "isDefault"
        FROM "Token" t
        JOIN "SupportedChain" sc ON t."chainId" = sc.id
        WHERE sc.id = 'stellar' AND t.symbol = 'XLM'
      `;

      if (Array.isArray(defaultTokens) && defaultTokens.length > 0) {
        tokensToReturn.push({
          source: "Default Options",
          tokens: defaultTokens,
        });
      }
    }

    res.json({
      options: tokensToReturn,
    });
  } catch (error) {
    console.error("Get settlement token options error:", error);
    res.status(500).json({ error: "Failed to get settlement token options" });
  }
};
