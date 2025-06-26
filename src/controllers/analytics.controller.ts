import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { createLogger } from "../utils/logger";
import { Prisma, ExpenseParticipant } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

const logger = createLogger("analytics-controller");

export const getAnalyticsController = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    logger.debug({ userId }, "Getting analytics data for user");

    // Get start and end of current month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const endOfMonth = new Date();
    endOfMonth.setMonth(endOfMonth.getMonth() + 1);
    endOfMonth.setDate(0);
    endOfMonth.setHours(23, 59, 59, 999);

    // Calculate current balances (what user owes and is owed)
    // Get individual balances where user owes money (positive amounts)
    const individualOwed = await prisma.balance.aggregate({
      _sum: { amount: true },
      where: {
        userId: userId,
        amount: { gt: 0 },
      },
    });

    // Get individual balances where user is owed money (negative amounts)
    const individualLent = await prisma.balance.aggregate({
      _sum: { amount: true },
      where: {
        userId: userId,
        amount: { lt: 0 },
      },
    });

    // Calculate total owed (positive balances) - only from Balance table
    const totalOwed = individualOwed._sum?.amount || 0;
    const owed = totalOwed.toFixed(2);

    // Calculate total lent (negative balances) - only from Balance table
    const totalLent = Math.abs(individualLent._sum?.amount || 0);
    const lent = totalLent.toFixed(2);

    // Get settlements for this month - use the original debt amounts (afterSettlementBalance)
    const settlementsThisMonth = await prisma.settlementItem.findMany({
      where: {
        OR: [
          { userId: userId },
          { friendId: userId }
        ],
        settlementTransaction: {
          status: "COMPLETED",
          completedAt: {
            gte: startOfMonth,
            lte: endOfMonth
          }
        }
      },
      include: {
        settlementTransaction: true
      }
    });

    let totalSettled = new Decimal(0);
    settlementsThisMonth.forEach((settlement) => {
      // Use the original debt amount (afterSettlementBalance) if available, otherwise use the settlement amount
      const settlementAmount = settlement.afterSettlementBalance || settlement.amount;
      totalSettled = totalSettled.plus(new Decimal(settlementAmount.toString()));
    });

    const settled = totalSettled.toFixed(2);

    logger.info(
      { userId, totalOwed: owed, totalLent: lent, totalSettled: settled },
      "Successfully retrieved analytics data"
    );

    res.status(200).json({
      owed: `$${owed} USD`,
      lent: `$${lent} USD`,
      settled: `$${settled} USD`
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, "Failed to get analytics data");
    res.status(500).json({ error: "Failed to get analytics data" });
  }
};
