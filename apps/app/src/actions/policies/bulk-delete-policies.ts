'use server';

import { BUCKET_NAME, s3Client } from '@/app/s3';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { db } from '@db';
import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';
import { authActionClient } from '../safe-action';

const bulkDeletePoliciesSchema = z.object({
  policyIds: z.array(z.string()).min(1, 'At least one policy is required'),
});

export const bulkDeletePoliciesAction = authActionClient
  .inputSchema(bulkDeletePoliciesSchema)
  .metadata({
    name: 'bulk-delete-policies',
    track: {
      event: 'bulk-delete-policies',
      description: 'Bulk Delete Policies',
      channel: 'server',
    },
  })
  .action(async ({ parsedInput, ctx }) => {
    const { policyIds } = parsedInput;
    const { activeOrganizationId } = ctx.session;

    if (!activeOrganizationId) {
      return { success: false, error: 'Not authorized' };
    }

    try {
      const policies = await db.policy.findMany({
        where: {
          id: { in: policyIds },
          organizationId: activeOrganizationId,
        },
        include: {
          versions: {
            select: { pdfUrl: true },
          },
        },
      });

      if (policies.length === 0) {
        return { success: false, error: 'No policies found' };
      }

      if (s3Client && BUCKET_NAME) {
        const pdfUrlsToDelete: string[] = [];

        for (const policy of policies) {
          if (policy.pdfUrl) {
            pdfUrlsToDelete.push(policy.pdfUrl);
          }
          for (const version of policy.versions) {
            if (version.pdfUrl) {
              pdfUrlsToDelete.push(version.pdfUrl);
            }
          }
        }

        await Promise.allSettled(
          pdfUrlsToDelete.map((pdfUrl) =>
            s3Client.send(
              new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: pdfUrl,
              }),
            ),
          ),
        );
      }

      await db.policy.deleteMany({
        where: {
          id: { in: policies.map((p) => p.id) },
          organizationId: activeOrganizationId,
        },
      });

      revalidatePath(`/${activeOrganizationId}/policies`);
      revalidateTag('policies', 'max');

      return { success: true, deletedCount: policies.length };
    } catch (error) {
      console.error('Bulk delete policies error:', error);
      return { success: false, error: 'Failed to delete policies' };
    }
  });
