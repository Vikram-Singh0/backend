import { prisma } from "../lib/prisma";
import { ReminderType, ReminderStatus } from "@prisma/client";
import { z } from "zod";

const reminderSchema = z.object({
  receiverId: z.string().min(1, "Receiver ID is required"),
  reminderType: z.enum([ReminderType.USER, ReminderType.SPLIT]),
  splitId: z.string().optional(),
  content: z.string().optional(),
});

export const createReminder = async (senderId: string, reminderData: any) => {
  const result = reminderSchema.safeParse(reminderData);
  if (!result.success) {
    throw new Error(`Invalid reminder data: ${result.error.message}`);
  }
  const { receiverId, reminderType, splitId, content } = result.data;

  try {
    // Validate that the receiver exists
    const receiver = await prisma.user.findUnique({
      where: { id: receiverId }
    });
    if (!receiver) {
      throw new Error("Receiver not found");
    }

    let userReminderAmount = undefined;
    // For USER type reminders, check if there's any balance
    if (reminderType === ReminderType.USER) {
      // FIX: Check if receiver owes any money to sender
      const balance = await prisma.balance.findFirst({
        where: {
          userId: receiverId, // receiver is the one who owes
          friendId: senderId, // sender is the one requesting
          amount: {
            gt: 0
          }
        }
      });

      if (!balance) {
        throw new Error("You don't owe this user any money");
      }
      userReminderAmount = balance.amount;
    }
    // For SPLIT type reminders, validate the expense
    else if (reminderType === ReminderType.SPLIT) {
      if (!splitId) {
        throw new Error("Split ID is required for expense reminders");
      }

      // Check if the expense exists
      const expense = await prisma.expense.findUnique({
        where: { id: splitId },
        include: {
          expenseParticipants: true,
          paidByUser: {
            select: {
              id: true,
              name: true
            }
          }
        }
      });

      if (!expense) {
        throw new Error("Expense not found");
      }

      // Check if sender is the one who paid
      const senderIsPayer = expense.paidBy === senderId;

      // Check if receiver owes money in this expense
      const receiverParticipant = expense.expenseParticipants.find(
        p => p.userId === receiverId
      );

      if (!receiverParticipant) {
        throw new Error("Receiver is not a participant in this expense");
      }

      // Only allow reminder if sender paid and receiver owes money
      if (!senderIsPayer) {
        throw new Error("Only the person who paid can send reminders for this expense");
      }

      // Calculate if receiver actually owes money
      const receiverAmount = receiverParticipant.amount;
      if (receiverAmount <= 0) {
        throw new Error("Receiver doesn't owe any money in this expense");
      }
    }

    const reminder = await prisma.userReminder.create({
      data: {
        senderId,
        receiverId,
        reminderType,
        splitId: reminderType === ReminderType.SPLIT ? splitId : null,
        content,
        status: ReminderStatus.PENDING,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
          }
        },
        split: reminderType === ReminderType.SPLIT && splitId ? {
          select: {
            id: true,
            name: true,
            amount: true,
            paidByUser: {
              select: {
                id: true,
                name: true
              }
            },
            expenseParticipants: {
              where: {
                userId: receiverId
              },
              select: {
                amount: true
              }
            }
          }
        } : undefined
      }
    });
    // Add amount only for USER reminders
    if (reminderType === ReminderType.USER && userReminderAmount !== undefined) {
      return { ...reminder, amount: userReminderAmount };
    }
    return reminder;
  } catch (error: any) {
    console.error("Error creating reminder:", error);
    throw new Error("Failed to create reminder: " + error.message);
  }
};

export const getRemindersForUser = async (receiverId: string) => {
  try {
    const reminders = await prisma.userReminder.findMany({
      where: {
        receiverId: receiverId,
        status: ReminderStatus.PENDING,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
          },
        },
        split: {
          select: {
            id: true,
            name: true,
            amount: true,
            paidByUser: {
              select: {
                id: true,
                name: true
              }
            },
            expenseParticipants: {
              where: {
                userId: receiverId
              },
              select: {
                amount: true
              }
            }
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    // For USER reminders, fetch the amount owed and add it to each reminder
    const remindersWithAmount = await Promise.all(reminders.map(async (reminder) => {
      if (reminder.reminderType === ReminderType.USER) {
        const balance = await prisma.balance.findFirst({
          where: {
            userId: reminder.receiverId, // receiver is the one who owes
            friendId: reminder.senderId, // sender is the one requesting
            amount: {
              gt: 0
            }
          }
        });
        if (balance) {
          return { ...reminder, amount: balance.amount };
        }
      }
      return reminder;
    }));
    return remindersWithAmount;
  } catch (error: any) {
    console.error("Error getting reminders for user:", error);
    throw new Error("Failed to get reminders: " + error.message);
  }
};

export const acceptReminder = async (reminderId: string, userId: string) => {
  try {
    // Find the reminder and make sure it belongs to the user
    const reminder = await prisma.userReminder.findFirst({
      where: {
        id: reminderId,
        receiverId: userId,
        status: ReminderStatus.PENDING,
      },
    });

    if (!reminder) {
      throw new Error("Reminder not found or already processed");
    }

    // Update the reminder status
    const updatedReminder = await prisma.userReminder.update({
      where: { id: reminderId },
      data: { status: ReminderStatus.COMPLETED },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
          },
        },
        split: {
          select: {
            id: true,
            name: true,
            amount: true,
            paidByUser: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    return updatedReminder;
  } catch (error: any) {
    console.error("Error accepting reminder:", error);
    throw new Error("Failed to accept reminder: " + error.message);
  }
};

export const rejectReminder = async (reminderId: string, userId: string) => {
  try {
    // Find the reminder and make sure it belongs to the user
    const reminder = await prisma.userReminder.findFirst({
      where: {
        id: reminderId,
        receiverId: userId,
        status: ReminderStatus.PENDING,
      },
    });

    if (!reminder) {
      throw new Error("Reminder not found or already processed");
    }

    // Update the reminder status
    const updatedReminder = await prisma.userReminder.update({
      where: { id: reminderId },
      data: { status: ReminderStatus.CANCELLED },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
          },
        },
        split: {
          select: {
            id: true,
            name: true,
            amount: true,
            paidByUser: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    return updatedReminder;
  } catch (error: any) {
    console.error("Error rejecting reminder:", error);
    throw new Error("Failed to reject reminder: " + error.message);
  }
};
