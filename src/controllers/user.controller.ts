import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  addUserExpense,
  editExpense,
  getCompleteFriendsDetails,
} from "../services/split.service";
import { SplitType } from "@prisma/client";
import { auth } from "../lib/auth";
import { fromNodeHeaders } from "better-auth/node";
import { checkAccountExists } from "../utils/stellar";
import { z } from "zod";
import crypto from "crypto";

export const getCurrentUser = async (req: Request, res: Response) => {
  res.json(req.user);
};

export const getBalances = async (req: Request, res: Response) => {
  const userId = req.user!.id;

  try {
    // const balancesRaw = await prisma.balance.findMany({
    //   where: {
    //     userId,
    //   },
    //   orderBy: {
    //     amount: "desc",
    //   },
    //   include: {
    //     friend: true,
    //   },
    // });

    // const balances = balancesRaw
    //   .reduce((acc, current) => {
    //     const existing = acc.findIndex(
    //       (item) => item.friendId === current.friendId
    //     );
    //     if (existing === -1) {
    //       acc.push(current);
    //     } else {
    //       const existingItem = acc[existing];
    //       if (existingItem) {
    //         if (Math.abs(existingItem.amount) > Math.abs(current.amount)) {
    //           acc[existing] = { ...existingItem, hasMore: true };
    //         } else {
    //           acc[existing] = { ...current, hasMore: true };
    //         }
    //       }
    //     }
    //     return acc;
    //   }, [] as ((typeof balancesRaw)[number] & { hasMore?: boolean })[])
    //   .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const cumulatedBalances = await prisma.balance.groupBy({
      by: ["currency"],
      _sum: {
        amount: true,
      },
      where: {
        userId,
      },
    });

    const youOwe: any[] = [];
    const youGet: any[] = [];
    for (const b of cumulatedBalances) {
      const sumAmount = b._sum.amount;
      if (sumAmount && sumAmount > 0) {
        youOwe.push({ currency: b.currency, amount: Math.abs(sumAmount) });
      } else if (sumAmount && sumAmount < 0) {
        youGet.push({ currency: b.currency, amount: Math.abs(sumAmount) });
      }
    }

    res.json({ cumulatedBalances, youOwe, youGet });
  } catch (error) {
    res.status(500).json({ error: "Failed to get balances" });
  }
};

// export const getFriends = async (req: Request, res: Response) => {
//   const userId = req.user!.id;

//   try {
//     const balanceWithFriends = await prisma.balance.findMany({
//       where: {
//         userId,
//       },
//       select: {
//         friendId: true,
//       },
//       distinct: ['friendId'],
//     });

//     const friendsIds = balanceWithFriends.map((f) => f.friendId);

//     const friends = await prisma.user.findMany({
//       where: {
//         id: {
//           in: friendsIds,
//         },
//       },
//     });

//     res.json(friends);
//   } catch (error) {
//     console.error('Get friends error:', error);
//     res.status(500).json({ error: 'Failed to fetch friends' });
//   }
// };

export const addOrEditExpense = async (
  req: Request,
  res: Response
): Promise<void> => {
  const userId = req.user!.id;
  const {
    paidBy,
    name,
    category,
    amount,
    splitType,
    currency,
    participants,
    fileKey,
    expenseDate,
    expenseId,
  } = req.body;

  try {
    if (expenseId) {
      const expenseParticipant = await prisma.expenseParticipant.findUnique({
        where: {
          expenseId_userId: {
            expenseId,
            userId,
          },
        },
      });

      if (!expenseParticipant) {
        res
          .status(403)
          .json({ error: "You are not a participant of this expense" });
        return;
      }
    }

    const expense = expenseId
      ? await editExpense(
          expenseId,
          paidBy,
          name,
          category,
          amount,
          splitType as SplitType,
          currency,
          participants,
          userId,
          expenseDate ?? new Date(),
          fileKey
        )
      : await addUserExpense(
          paidBy,
          name,
          category,
          amount,
          splitType as SplitType,
          currency,
          participants,
          userId,
          expenseDate ?? new Date(),
          fileKey
        );

    res.json(expense);
  } catch (error) {
    console.error("Add/Edit expense error:", error);
    res.status(500).json({ error: "Failed to create/edit expense" });
  }
};

export const getExpensesWithFriend = async (req: Request, res: Response) => {
  const { friendId } = req.params;
  const userId = req.user!.id;

  try {
    const expenses = await prisma.expense.findMany({
      where: {
        OR: [
          {
            paidBy: userId,
            expenseParticipants: {
              some: {
                userId: friendId,
              },
            },
          },
          {
            paidBy: friendId,
            expenseParticipants: {
              some: {
                userId,
              },
            },
          },
        ],
        AND: [
          {
            deletedBy: null,
          },
        ],
      },
      orderBy: {
        expenseDate: "desc",
      },
      include: {
        expenseParticipants: {
          where: {
            OR: [
              {
                userId,
              },
              {
                userId: friendId,
              },
            ],
          },
        },
      },
    });

    res.json(expenses);
  } catch (error) {
    console.error("Get expenses with friend error:", error);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
};

export const updateUserDetails = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { name, currency, stellarAccount, image, timeLockInDefault } = req.body;

  if (stellarAccount) {
    const accountExists = await checkAccountExists(stellarAccount);
    if (!accountExists) {
      res.status(400).json({ error: "Invalid Stellar account" });
      return;
    }
  }

  try {
    const user = await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        ...(name && { name }),
        ...(currency && { currency }),
        ...(stellarAccount && { stellarAccount }),
        ...(image && { image }),
        ...(typeof timeLockInDefault === 'boolean' ? { timeLockInDefault } : {}),
      },
    });

    const a = await auth.api.getSession({
      query: {
        disableCookieCache: true,
      },
      headers: fromNodeHeaders(req.headers),
    });

    console.log(a);

    res.json(user);
  } catch (error) {
    console.error("Update user details error:", error);
    res.status(500).json({ error: "Failed to update user details" });
  }
};

export const inviteFriend = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { email } = req.body;
  const userId = req.user!.id;

  try {
    const friend = await prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (friend) {
      res.json(friend);
      return;
    }

    const user = await prisma.user.create({
      data: {
        email,
        name: email.split("@")[0],
        emailVerified: false,
      },
    });

    res.json(user);
  } catch (error) {
    console.error("Invite friend error:", error);
    res.status(500).json({ error: "Failed to invite friend" });
  }
};

export const addFriend = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { friendIdentifier } = req.body;

  try {
    const friend = await prisma.user.findFirst({
      where: {
        OR: [{ email: friendIdentifier }, { name: friendIdentifier }],
      },
    });

    if (!friend) {
      res.status(404).json({ message: "Friend not found", status: "error" });
      return;
    }
    if (friend.id === userId) {
      res
        .status(400)
        .json({ message: "Cannot add yourself as friend", status: "error" });
      return;
    }

    // Check if friendship already exists
    const existingFriendship = await prisma.friendship.findFirst({
      where: {
        userId: userId,
        friendId: friend.id,
      },
    });

    if (existingFriendship) {
      res.json({ message: "Already friends", status: "success" });
      return;
    }

    await prisma.$transaction([
      prisma.friendship.create({
        data: {
          userId: userId,
          friendId: friend.id,
        },
      }),
      prisma.friendship.create({
        data: {
          userId: friend.id,
          friendId: userId,
        },
      }),
    ]);

    res.json({ message: "Friend added successfully", status: "success" });
  } catch (error) {
    console.error("Add friend error:", error);
    res.status(500).json({ error: "Failed to add friend" });
  }
};

export const getFriends = async (
  req: Request,
  res: Response
): Promise<void> => {
  const userId = req.user!.id;

  try {
    const friends = await getCompleteFriendsDetails(userId);
    // const friends = await prisma.friendship.findMany({
    //   where: { userId },
    //   include: {
    //     friend: {
    //       select: {
    //         id: true,
    //         name: true,
    //         email: true,
    //         image: true,
    //       },
    //     },
    //   },
    // });

    res.json(friends);
  } catch (error) {
    console.error("Get friends error:", error);
    res.status(500).json({ error: "Failed to fetch friends" });
  }
};

export const getUserAcceptedTokens = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const acceptedTokens = await prisma.$queryRaw`
      SELECT ut.*, t.name, t.symbol, t.decimals, t.type, t.logoUrl, 
             sc.name as chainName, sc.currency as chainCurrency, sc.logoUrl as chainLogoUrl
      FROM "UserAcceptedToken" ut
      JOIN "Token" t ON ut."tokenId" = t.id
      JOIN "SupportedChain" sc ON ut."chainId" = sc.id
      WHERE ut."userId" = ${userId}
    `;

    res.json(acceptedTokens);
  } catch (error) {
    console.error("Get user accepted tokens error:", error);
    res.status(500).json({ error: "Failed to fetch accepted tokens" });
  }
};

const tokenSchema = z.object({
  tokenId: z.string().min(1, "Token ID is required"),
  chainId: z.string().min(1, "Chain ID is required"),
  isDefault: z.boolean().optional(),
});

export const addUserAcceptedToken = async (req: Request, res: Response) => {
  try {
    const result = tokenSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({ error: result.error.issues });
      return;
    }

    const userId = req.user!.id;
    const { tokenId, chainId, isDefault = false } = result.data;

    // Check if token exists
    const token = await prisma.token.findUnique({
      where: { id: tokenId },
    });

    if (!token) {
      res.status(404).json({ error: "Token not found" });
      return;
    }

    // Check if chain exists
    const chain = await prisma.supportedChain.findUnique({
      where: { id: chainId },
    });

    if (!chain) {
      res.status(404).json({ error: "Chain not found" });
      return;
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await prisma.$executeRaw`
        UPDATE "UserAcceptedToken" 
        SET "isDefault" = false 
        WHERE "userId" = ${userId} AND "isDefault" = true
      `;
    }

    // Check if the token acceptance already exists
    const existingToken = await prisma.$queryRaw`
      SELECT * FROM "UserAcceptedToken"
      WHERE "userId" = ${userId} AND "tokenId" = ${tokenId} AND "chainId" = ${chainId}
    `;

    let acceptedToken;
    if (Array.isArray(existingToken) && existingToken.length > 0) {
      // Update existing
      acceptedToken = await prisma.$executeRaw`
        UPDATE "UserAcceptedToken"
        SET "isDefault" = ${isDefault}
        WHERE "userId" = ${userId} AND "tokenId" = ${tokenId} AND "chainId" = ${chainId}
        RETURNING *
      `;
    } else {
      // Create new
      acceptedToken = await prisma.$executeRaw`
        INSERT INTO "UserAcceptedToken" ("id", "userId", "tokenId", "chainId", "isDefault", "createdAt", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${userId}, ${tokenId}, ${chainId}, ${isDefault}, NOW(), NOW())
        RETURNING *
      `;
    }

    res.json(acceptedToken);
  } catch (error) {
    console.error("Add user accepted token error:", error);
    res.status(500).json({ error: "Failed to add accepted token" });
  }
};

export const removeUserAcceptedToken = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const token = await prisma.$queryRaw`
      SELECT * FROM "UserAcceptedToken"
      WHERE "id" = ${id}
    `;

    if (!Array.isArray(token) || token.length === 0) {
      res.status(404).json({ error: "Token not found" });
      return;
    }

    if (token[0].userId !== userId) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }

    await prisma.$executeRaw`
      DELETE FROM "UserAcceptedToken"
      WHERE "id" = ${id}
    `;

    res.json({ success: true });
  } catch (error) {
    console.error("Remove user accepted token error:", error);
    res.status(500).json({ error: "Failed to remove accepted token" });
  }
};
