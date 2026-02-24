'use server';

import { db, Departments, Frequency, PolicyDisplayFormat, PolicyStatus, type Prisma } from '@db';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { BUCKET_NAME, s3Client } from '@/app/s3';
import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';
import { authActionClient } from '../safe-action';

const fileEntrySchema = z.object({
  fileName: z.string().min(1),
  fileType: z.string().min(1),
  fileData: z.string().min(1),
});

const bulkUploadPoliciesSchema = z.object({
  files: z.array(fileEntrySchema).min(1, 'At least one file is required').max(50),
});

function formatPolicyName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');

  const spaced = withoutExtension
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-+.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return spaced
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export const bulkUploadPoliciesAction = authActionClient
  .inputSchema(bulkUploadPoliciesSchema)
  .metadata({
    name: 'bulk-upload-policies',
    track: {
      event: 'bulk-upload-policies',
      description: 'Bulk Upload Policies',
      channel: 'server',
    },
  })
  .action(async ({ parsedInput, ctx }) => {
    const { files } = parsedInput;
    const { activeOrganizationId } = ctx.session;
    const { user } = ctx;

    if (!activeOrganizationId) {
      return { success: false, error: 'Not authorized' };
    }

    if (!user) {
      return { success: false, error: 'Not authorized' };
    }

    if (!s3Client || !BUCKET_NAME) {
      return { success: false, error: 'File storage is not configured.' };
    }

    const member = await db.member.findFirst({
      where: {
        userId: user.id,
        organizationId: activeOrganizationId,
        deactivated: false,
      },
    });

    if (!member) {
      return { success: false, error: 'Not authorized' };
    }

    const initialContent = [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '' }],
      },
    ] as Prisma.InputJsonValue[];

    const results: { fileName: string; policyId: string; success: boolean; error?: string }[] = [];

    for (const file of files) {
      try {
        const policyName = formatPolicyName(file.fileName);

        const { policy, versionId } = await db.$transaction(async (tx) => {
          const newPolicy = await tx.policy.create({
            data: {
              name: policyName,
              description: `Uploaded from ${file.fileName}`,
              organizationId: activeOrganizationId,
              assigneeId: member.id,
              department: Departments.none,
              frequency: Frequency.monthly,
              status: PolicyStatus.draft,
              content: initialContent,
              draftContent: initialContent,
              displayFormat: PolicyDisplayFormat.PDF,
            },
          });

          const version = await tx.policyVersion.create({
            data: {
              policyId: newPolicy.id,
              version: 1,
              content: initialContent,
              publishedById: member.id,
              changelog: 'Initial version (uploaded PDF)',
            },
          });

          const updatedPolicy = await tx.policy.update({
            where: { id: newPolicy.id },
            data: { currentVersionId: version.id },
          });

          return { policy: updatedPolicy, versionId: version.id };
        });

        const sanitizedFileName = file.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const s3Key = `${activeOrganizationId}/policies/${policy.id}/v1-${Date.now()}-${sanitizedFileName}`;

        const fileBuffer = Buffer.from(file.fileData, 'base64');
        await s3Client.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: file.fileType,
          }),
        );

        await db.$transaction([
          db.policy.update({
            where: { id: policy.id },
            data: { pdfUrl: s3Key },
          }),
          db.policyVersion.update({
            where: { id: versionId },
            data: { pdfUrl: s3Key },
          }),
        ]);

        results.push({ fileName: file.fileName, policyId: policy.id, success: true });
      } catch (error) {
        console.error(`Failed to create policy for ${file.fileName}:`, error);
        results.push({
          fileName: file.fileName,
          policyId: '',
          success: false,
          error: 'Failed to create policy',
        });
      }
    }

    revalidatePath(`/${activeOrganizationId}/policies`);
    revalidateTag('policies', 'max');

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return {
      success: failCount === 0,
      results,
      summary: { total: files.length, succeeded: successCount, failed: failCount },
    };
  });
