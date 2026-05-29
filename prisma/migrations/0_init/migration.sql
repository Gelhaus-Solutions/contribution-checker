-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "ghId" INTEGER,
    "ghLogin" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "canCreateProj" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "formSchema" TEXT NOT NULL DEFAULT '[]',
    "templateId" TEXT,
    "cooldownDays" INTEGER,
    "bypassHandles" TEXT NOT NULL DEFAULT '[]',
    "bypassCollabs" BOOLEAN NOT NULL DEFAULT true,
    "labelsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "labelPending" TEXT NOT NULL DEFAULT 'contribution:pending',
    "labelApproved" TEXT NOT NULL DEFAULT 'contribution:approved',
    "labelDenied" TEXT NOT NULL DEFAULT 'contribution:denied',
    "labelEvaluate" TEXT NOT NULL DEFAULT 'contribution:evaluate',
    "checkerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trackWhenDisabled" BOOLEAN NOT NULL DEFAULT false,
    "checksEnabled" BOOLEAN NOT NULL DEFAULT true,
    "qualityEnabled" BOOLEAN NOT NULL DEFAULT false,
    "qualityConfig" TEXT NOT NULL DEFAULT '{}',
    "qualityCommentMin" INTEGER NOT NULL DEFAULT 20,
    "prTemplateHoneypots" TEXT NOT NULL DEFAULT '[]',
    "qualityTemplateMatchPct" INTEGER NOT NULL DEFAULT 80,
    "requireApprovalCount" INTEGER NOT NULL DEFAULT 0,
    "applicationRequired" BOOLEAN NOT NULL DEFAULT true,
    "claEnabled" BOOLEAN NOT NULL DEFAULT false,
    "claRequired" BOOLEAN NOT NULL DEFAULT true,
    "claCorporateEnabled" BOOLEAN NOT NULL DEFAULT true,
    "claPlacementEmbed" BOOLEAN NOT NULL DEFAULT true,
    "claPlacementStandalone" BOOLEAN NOT NULL DEFAULT true,
    "labelClaPending" TEXT NOT NULL DEFAULT 'contribution:cla-pending',
    "minIclaVersion" INTEGER NOT NULL DEFAULT 0,
    "minCclaVersion" INTEGER NOT NULL DEFAULT 0,
    "currentIclaVersionId" TEXT,
    "currentCclaVersionId" TEXT,
    "claAutoVersionRequiresResign" BOOLEAN NOT NULL DEFAULT false,
    "claIclaRequireSignature" BOOLEAN NOT NULL DEFAULT true,
    "claIclaCustomFields" TEXT NOT NULL DEFAULT '[]',
    "claCclaCustomFields" TEXT NOT NULL DEFAULT '[]',
    "dcoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectWebhook" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualDecision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ghLogin" TEXT NOT NULL,
    "ghId" INTEGER,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repo" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ghRepoId" INTEGER,
    "fullName" TEXT NOT NULL,
    "installationId" INTEGER,
    "requireOwnApproval" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repoId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "answers" TEXT NOT NULL DEFAULT '{}',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "allowResubmit" BOOLEAN NOT NULL DEFAULT true,
    "cooldownUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationNote" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "reviewId" TEXT,
    "parentId" TEXT,
    "fieldId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'INTERNAL',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ApplicationNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationReview" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "body" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'INTERNAL',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ApplicationReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrCheck" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "prNodeId" TEXT NOT NULL,
    "authorGhLogin" TEXT NOT NULL,
    "authorGhId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "closedByApp" BOOLEAN NOT NULL DEFAULT false,
    "gateReason" TEXT,
    "checkRunId" TEXT,
    "headSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrQuality" (
    "id" TEXT NOT NULL,
    "prCheckId" TEXT NOT NULL,
    "signalsRaw" TEXT NOT NULL DEFAULT '{}',
    "fetchedRaw" TEXT NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrQuality_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormTemplate" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "endpointId" TEXT,
    "event" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "payload" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredById" TEXT,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedWebhookDelivery" (
    "id" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobQueue" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaDocumentVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "sourceRepoId" TEXT,
    "sourcePath" TEXT,
    "sourceRef" TEXT,
    "sourceCommitSha" TEXT,
    "requireResign" BOOLEAN NOT NULL DEFAULT false,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaSignature" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "ghId" INTEGER NOT NULL,
    "ghLogin" TEXT NOT NULL,
    "emailSnapshot" TEXT,
    "legalName" TEXT NOT NULL,
    "affirmation" TEXT NOT NULL,
    "agreed" BOOLEAN NOT NULL DEFAULT true,
    "documentVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "signatureKind" TEXT,
    "signatureText" TEXT,
    "signatureImage" TEXT,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "applicationId" TEXT,
    "customFields" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorporateCla" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "signatureId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "registeredAddress" TEXT,
    "country" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT NOT NULL,
    "signatoryTitle" TEXT,
    "signatureText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorporateCla_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CclaRosterMember" (
    "id" TEXT NOT NULL,
    "corporateId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ghLogin" TEXT NOT NULL,
    "ghId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "addedById" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "disputedAt" TIMESTAMP(3),
    "disputeNote" TEXT,

    CONSTRAINT "CclaRosterMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaWaiver" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ghLogin" TEXT NOT NULL,
    "ghId" INTEGER,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ClaWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaEventLog" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorGhId" INTEGER,
    "signatureId" TEXT,
    "documentVersionId" TEXT,
    "rosterMemberId" TEXT,
    "corporateId" TEXT,
    "waiverId" TEXT,
    "prevHash" TEXT NOT NULL,
    "entryHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_ghId_key" ON "User"("ghId");

-- CreateIndex
CREATE UNIQUE INDEX "User_ghLogin_key" ON "User"("ghLogin");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "ProjectWebhook_projectId_idx" ON "ProjectWebhook"("projectId");

-- CreateIndex
CREATE INDEX "ManualDecision_ghId_idx" ON "ManualDecision"("ghId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualDecision_projectId_ghLogin_key" ON "ManualDecision"("projectId", "ghLogin");

-- CreateIndex
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Repo_ghRepoId_key" ON "Repo"("ghRepoId");

-- CreateIndex
CREATE INDEX "Repo_projectId_idx" ON "Repo"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Repo_projectId_fullName_key" ON "Repo"("projectId", "fullName");

-- CreateIndex
CREATE INDEX "Application_projectId_status_idx" ON "Application"("projectId", "status");

-- CreateIndex
CREATE INDEX "Application_userId_idx" ON "Application"("userId");

-- CreateIndex
CREATE INDEX "ApplicationNote_applicationId_fieldId_idx" ON "ApplicationNote"("applicationId", "fieldId");

-- CreateIndex
CREATE INDEX "ApplicationNote_reviewId_idx" ON "ApplicationNote"("reviewId");

-- CreateIndex
CREATE INDEX "ApplicationNote_parentId_idx" ON "ApplicationNote"("parentId");

-- CreateIndex
CREATE INDEX "ApplicationReview_applicationId_state_idx" ON "ApplicationReview"("applicationId", "state");

-- CreateIndex
CREATE INDEX "ApplicationReview_authorId_idx" ON "ApplicationReview"("authorId");

-- CreateIndex
CREATE INDEX "PrCheck_authorGhLogin_status_idx" ON "PrCheck"("authorGhLogin", "status");

-- CreateIndex
CREATE INDEX "PrCheck_authorGhId_status_idx" ON "PrCheck"("authorGhId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PrCheck_repoId_prNumber_key" ON "PrCheck"("repoId", "prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PrQuality_prCheckId_key" ON "PrQuality"("prCheckId");

-- CreateIndex
CREATE INDEX "PrQuality_prCheckId_idx" ON "PrQuality"("prCheckId");

-- CreateIndex
CREATE INDEX "AuditEvent_projectId_createdAt_idx" ON "AuditEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "FormTemplate_ownerId_idx" ON "FormTemplate"("ownerId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_projectId_createdAt_idx" ON "WebhookDelivery"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ProcessedWebhookDelivery_createdAt_idx" ON "ProcessedWebhookDelivery"("createdAt");

-- CreateIndex
CREATE INDEX "JobQueue_status_nextAttemptAt_idx" ON "JobQueue"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ClaDocumentVersion_projectId_kind_idx" ON "ClaDocumentVersion"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ClaDocumentVersion_projectId_kind_version_key" ON "ClaDocumentVersion"("projectId", "kind", "version");

-- CreateIndex
CREATE INDEX "ClaSignature_projectId_ghId_status_idx" ON "ClaSignature"("projectId", "ghId", "status");

-- CreateIndex
CREATE INDEX "ClaSignature_ghId_idx" ON "ClaSignature"("ghId");

-- CreateIndex
CREATE INDEX "ClaSignature_versionId_idx" ON "ClaSignature"("versionId");

-- CreateIndex
CREATE INDEX "ClaSignature_applicationId_idx" ON "ClaSignature"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "CorporateCla_signatureId_key" ON "CorporateCla"("signatureId");

-- CreateIndex
CREATE INDEX "CorporateCla_projectId_status_idx" ON "CorporateCla"("projectId", "status");

-- CreateIndex
CREATE INDEX "CclaRosterMember_projectId_ghId_status_idx" ON "CclaRosterMember"("projectId", "ghId", "status");

-- CreateIndex
CREATE INDEX "CclaRosterMember_projectId_ghLogin_status_idx" ON "CclaRosterMember"("projectId", "ghLogin", "status");

-- CreateIndex
CREATE INDEX "CclaRosterMember_corporateId_idx" ON "CclaRosterMember"("corporateId");

-- CreateIndex
CREATE INDEX "ClaWaiver_projectId_ghId_status_idx" ON "ClaWaiver"("projectId", "ghId", "status");

-- CreateIndex
CREATE INDEX "ClaWaiver_projectId_ghLogin_status_idx" ON "ClaWaiver"("projectId", "ghLogin", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClaEventLog_signatureId_key" ON "ClaEventLog"("signatureId");

-- CreateIndex
CREATE INDEX "ClaEventLog_projectId_kind_idx" ON "ClaEventLog"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ClaEventLog_projectId_seq_key" ON "ClaEventLog"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectWebhook" ADD CONSTRAINT "ProjectWebhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualDecision" ADD CONSTRAINT "ManualDecision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualDecision" ADD CONSTRAINT "ManualDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repo" ADD CONSTRAINT "Repo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ApplicationReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ApplicationNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationReview" ADD CONSTRAINT "ApplicationReview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationReview" ADD CONSTRAINT "ApplicationReview_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrCheck" ADD CONSTRAINT "PrCheck_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrQuality" ADD CONSTRAINT "PrQuality_prCheckId_fkey" FOREIGN KEY ("prCheckId") REFERENCES "PrCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormTemplate" ADD CONSTRAINT "FormTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "ProjectWebhook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaDocumentVersion" ADD CONSTRAINT "ClaDocumentVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaSignature" ADD CONSTRAINT "ClaSignature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaSignature" ADD CONSTRAINT "ClaSignature_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ClaDocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaSignature" ADD CONSTRAINT "ClaSignature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaSignature" ADD CONSTRAINT "ClaSignature_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorporateCla" ADD CONSTRAINT "CorporateCla_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorporateCla" ADD CONSTRAINT "CorporateCla_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ClaDocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorporateCla" ADD CONSTRAINT "CorporateCla_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "ClaSignature"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CclaRosterMember" ADD CONSTRAINT "CclaRosterMember_corporateId_fkey" FOREIGN KEY ("corporateId") REFERENCES "CorporateCla"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CclaRosterMember" ADD CONSTRAINT "CclaRosterMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaWaiver" ADD CONSTRAINT "ClaWaiver_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaEventLog" ADD CONSTRAINT "ClaEventLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

