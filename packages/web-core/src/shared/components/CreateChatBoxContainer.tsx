import { useMemo, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropzone } from 'react-dropzone';
import { useCreateMode } from '@/features/create-mode/model/useCreateMode';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { useCreateWorkspace } from '@/shared/hooks/useCreateWorkspace';
import { useCreateAttachments } from '@/shared/hooks/useCreateAttachments';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { saveProjectRepoDefaults } from '@/shared/hooks/useProjectRepoDefaults';
import { getSortedExecutorVariantKeys } from '@/shared/lib/executor';
import {
  toPrettyCase,
  splitMessageToTitleDescription,
} from '@/shared/lib/string';
import type { BaseCodingAgent, ExecutorConfig, Repo } from 'shared/types';
import { CreateChatBox } from '@vibe/ui/components/CreateChatBox';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { CreateModeRepoPickerBar } from './CreateModeRepoPickerBar';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';

function getRepoDisplayName(repo: Repo) {
  return repo.display_name || repo.name;
}

const BRANCH_LABEL_MAX_CHARS = 15;

function truncateBranchLabel(branch: string) {
  return branch.length > BRANCH_LABEL_MAX_CHARS
    ? `${branch.slice(0, BRANCH_LABEL_MAX_CHARS)}...`
    : branch;
}

interface CreateChatBoxContainerProps {
  onWorkspaceCreated: (workspaceId: string) => void;
}

export function CreateChatBoxContainer({
  onWorkspaceCreated,
}: CreateChatBoxContainerProps) {
  const { t } = useTranslation('common');
  const { profiles, config } = useUserSystem();
  const {
    repos,
    targetBranches,
    message,
    setMessage,
    clearDraft,
    hasInitialValue,
    hasResolvedInitialRepoDefaults,
    linkedIssue,
    clearLinkedIssue,
    preferredExecutorConfig,
    executorConfig: draftConfig,
    setExecutorConfig: setDraftConfig,
    additionalExecutors,
    setAdditionalExecutors,
    attachments: draftAttachments,
    setAttachments: setDraftAttachments,
  } = useCreateMode();

  const { createWorkspace } = useCreateWorkspace();
  const hasSelectedRepos = repos.length > 0;
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  // Drive submit-pending UI from local state: createWorkspace.isPending is a
  // single-mutation observer that thrashes when we fan-out with N parallel
  // mutateAsync calls.
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Aggregated error from a fan-out where ALL agents failed. Partial failures
  // can't be surfaced here because we navigate away on first success.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [hasInitializedStep, setHasInitializedStep] = useState(false);
  const [isSelectingRepos, setIsSelectingRepos] = useState(true);

  useEffect(() => {
    if (!hasInitialValue || hasInitializedStep) return;
    if (!hasSelectedRepos && !hasResolvedInitialRepoDefaults) return;

    setIsSelectingRepos(!hasSelectedRepos);
    setHasInitializedStep(true);
  }, [
    hasInitialValue,
    hasInitializedStep,
    hasSelectedRepos,
    hasResolvedInitialRepoDefaults,
  ]);

  const showRepoPickerStep = !hasSelectedRepos || isSelectingRepos;
  const showChatStep = hasSelectedRepos && !isSelectingRepos;

  // Attachment handling - insert markdown and track attachment IDs
  const handleInsertMarkdown = useCallback(
    (markdown: string) => {
      const newMessage = message.trim()
        ? `${message}\n\n${markdown}`
        : markdown;
      setMessage(newMessage);
    },
    [message, setMessage]
  );

  const { uploadFiles, getAttachmentIds, clearAttachments, localAttachments } =
    useCreateAttachments(
      handleInsertMarkdown,
      draftAttachments,
      setDraftAttachments
    );

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        uploadFiles(acceptedFiles);
      }
    },
    [uploadFiles]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled: isSubmitting || !hasSelectedRepos,
    noClick: true,
    noKeyboard: true,
  });

  const scratchConfig = useMemo(() => {
    if (!hasInitialValue) return undefined; // still loading
    return draftConfig ?? null;
  }, [hasInitialValue, draftConfig]);

  const {
    executorConfig,
    effectiveExecutor,
    selectedVariant,
    executorOptions,
    variantOptions,
    presetOptions,
    setOverrides: setExecutorOverrides,
  } = useExecutorConfig({
    profiles,
    lastUsedConfig: preferredExecutorConfig,
    scratchConfig,
    configExecutorProfile: config?.executor_profile,
    onPersist: (cfg) => setDraftConfig(cfg),
  });

  const repoId = repos.length === 1 ? repos[0]?.id : undefined;
  const repoSummaryLabel = useMemo(() => {
    if (repos.length === 1) {
      const repo = repos[0];
      if (!repo) return '0 repositories selected';
      const selectedBranch = targetBranches[repo.id];
      const branch = selectedBranch
        ? truncateBranchLabel(selectedBranch)
        : 'Select branch';
      return `${getRepoDisplayName(repo)} · ${branch}`;
    }

    return `${repos.length} repositories selected`;
  }, [repos, targetBranches]);

  const repoSummaryTitle = useMemo(
    () =>
      repos
        .map((repo) => {
          const branch = targetBranches[repo.id] ?? 'Select branch';
          return `${getRepoDisplayName(repo)} (${branch})`;
        })
        .join('\n'),
    [repos, targetBranches]
  );

  const hasSelectedBranchesForAllRepos = repos.every(
    (repo) => !!targetBranches[repo.id]
  );

  // Determine if we can submit
  const canSubmit =
    hasSelectedRepos &&
    hasSelectedBranchesForAllRepos &&
    message.trim().length > 0 &&
    effectiveExecutor !== null;

  const handlePresetSelect = (presetId: string | null) => {
    if (!effectiveExecutor) return;
    setDraftConfig({
      ...draftConfig,
      executor: effectiveExecutor,
      variant: presetId,
    });
  };

  const handleCustomise = () => {
    SettingsDialog.show({ initialSection: 'agents' });
  };

  // Handle executor change - use saved variant if switching to default executor.
  // Also prune the new primary from the additional-agents list so we don't
  // double-run the same agent.
  const handleExecutorChange = useCallback(
    (executor: BaseCodingAgent) => {
      if (additionalExecutors.some((e) => e.executor === executor)) {
        setAdditionalExecutors(
          additionalExecutors.filter((e) => e.executor !== executor)
        );
      }

      const executorProfile = profiles?.[executor];
      if (!executorProfile) {
        setDraftConfig({ executor, variant: null });
        return;
      }

      const variants = getSortedExecutorVariantKeys(executorProfile);
      let targetVariant: string | null = null;

      // If switching to user's default executor, use their saved variant
      if (
        config?.executor_profile?.executor === executor &&
        config?.executor_profile?.variant
      ) {
        const savedVariant = config.executor_profile.variant;
        if (variants.includes(savedVariant)) {
          targetVariant = savedVariant;
        }
      }

      // Fallback to DEFAULT or first available
      if (!targetVariant) {
        targetVariant = variants.includes('DEFAULT')
          ? 'DEFAULT'
          : (variants[0] ?? null);
      }

      setDraftConfig({ executor, variant: targetVariant });
    },
    [
      profiles,
      setDraftConfig,
      config?.executor_profile,
      additionalExecutors,
      setAdditionalExecutors,
    ]
  );

  const handleToggleAdditional = useCallback(
    (executor: BaseCodingAgent) => {
      if (executor === effectiveExecutor) return;
      const exists = additionalExecutors.some((e) => e.executor === executor);
      // variant: null today → resolved to 'DEFAULT' at submit. Stored as
      // ExecutorProfileId (not BaseCodingAgent) so a future per-agent variant
      // picker can populate it without a state-shape migration.
      const next = exists
        ? additionalExecutors.filter((e) => e.executor !== executor)
        : [...additionalExecutors, { executor, variant: null }];
      setAdditionalExecutors(next);
    },
    [additionalExecutors, effectiveExecutor, setAdditionalExecutors]
  );

  // Handle submit — fan-out to N agents (primary + additional), one workspace each.
  // When only the primary is selected this is bit-identical to the original behavior
  // (no name suffix, single create call).
  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;
    setHasAttemptedSubmit(true);
    setSubmitError(null);
    if (!canSubmit || !executorConfig) return;

    const { title } = splitMessageToTitleDescription(message);

    const agentList: ExecutorConfig[] = [
      executorConfig,
      ...additionalExecutors
        .filter((e) => e.executor !== executorConfig.executor)
        .map<ExecutorConfig>((e) => ({
          executor: e.executor,
          variant: e.variant ?? 'DEFAULT',
        })),
    ];
    const multi = agentList.length > 1;

    const baseRepos = repos.map((r) => ({
      repo_id: r.id,
      target_branch: targetBranches[r.id]!,
    }));
    const linkedIssueReq = linkedIssue
      ? {
          remote_project_id: linkedIssue.remoteProjectId,
          issue_id: linkedIssue.issueId,
        }
      : null;
    const linkToIssue = linkedIssue
      ? {
          remoteProjectId: linkedIssue.remoteProjectId,
          issueId: linkedIssue.issueId,
        }
      : undefined;
    const attachmentIds = getAttachmentIds();

    setIsSubmitting(true);
    let results: PromiseSettledResult<{ workspace: { id: string } }>[];
    try {
      results = await Promise.allSettled(
        agentList.map((config) =>
          createWorkspace.mutateAsync({
            data: {
              executor_config: config,
              name: multi
                ? `${title} (${toPrettyCase(config.executor)})`
                : title,
              prompt: message,
              repos: baseRepos,
              linked_issue: linkedIssueReq,
              attachment_ids: attachmentIds,
            },
            linkToIssue,
          })
        )
      );
    } finally {
      setIsSubmitting(false);
    }

    const firstSuccess = results.find(
      (r) => r.status === 'fulfilled' && !!r.value.workspace
    );
    const firstWorkspace =
      firstSuccess?.status === 'fulfilled'
        ? firstSuccess.value.workspace
        : null;
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? agentList[i]!.executor : null))
      .filter((x): x is BaseCodingAgent => x !== null);

    if (!firstWorkspace) {
      // All N failed — stay on page and show aggregated error.
      const messages = results
        .map((r, i) => {
          if (r.status !== 'rejected') return null;
          const reason =
            r.reason instanceof Error ? r.reason.message : String(r.reason);
          return multi
            ? `${toPrettyCase(agentList[i]!.executor)}: ${reason}`
            : reason;
        })
        .filter((x): x is string => x !== null);
      setSubmitError(
        messages.length > 0
          ? messages.join('\n')
          : 'Failed to create workspace.'
      );
      return;
    }

    // Partial failure: we navigate away on first success, so a banner here
    // would unmount before the user could read it. Log to console so it's
    // discoverable in devtools at least.
    if (failed.length > 0) {
      console.warn(
        `[create-workspace] Created ${results.length - failed.length}/${results.length}. Failed: ${failed.map(toPrettyCase).join(', ')}`
      );
    }

    if (linkedIssue?.remoteProjectId) {
      saveProjectRepoDefaults(linkedIssue.remoteProjectId, baseRepos).catch(
        (err) => console.warn('Failed to save project repo defaults:', err)
      );
    }

    clearAttachments();
    await clearDraft();
    onWorkspaceCreated(firstWorkspace.id);
  }, [
    isSubmitting,
    canSubmit,
    executorConfig,
    additionalExecutors,
    message,
    repos,
    targetBranches,
    createWorkspace,
    onWorkspaceCreated,
    getAttachmentIds,
    clearAttachments,
    clearDraft,
    linkedIssue,
  ]);

  // Determine error to display. submitError is the authoritative aggregated
  // error from the last all-failed fan-out — we no longer read
  // createWorkspace.error here because the single-mutation observer is racy
  // under parallel mutateAsync.
  const displayError =
    hasAttemptedSubmit && repos.length === 0
      ? 'Add at least one repository to create a workspace'
      : hasAttemptedSubmit && !hasSelectedBranchesForAllRepos
        ? 'Select a branch for every repository before creating a workspace'
        : submitError;

  // Wait for initial value to be applied before rendering
  // This ensures the editor mounts with content ready, so autoFocus works correctly
  if (!hasInitialValue) {
    return null;
  }

  return (
    <div className="relative flex flex-1 flex-col bg-primary h-full">
      <div className="flex flex-1 items-center justify-center px-base">
        <div className="flex w-chat max-w-full flex-col gap-base">
          {showRepoPickerStep && (
            <>
              <h2 className="mb-double text-center text-4xl font-medium tracking-tight text-high">
                {t('createMode.headings.repoStep')}
              </h2>
              <CreateModeRepoPickerBar
                onContinueToPrompt={() => setIsSelectingRepos(false)}
              />
            </>
          )}

          {showChatStep && (
            <>
              <h2 className="mb-double text-center text-4xl font-medium tracking-tight text-high">
                {t('createMode.headings.chatStep')}
              </h2>

              <div className="flex justify-center @container">
                <CreateChatBox
                  editor={{
                    value: message,
                    onChange: setMessage,
                  }}
                  renderEditor={({
                    value,
                    onChange,
                    onCmdEnter,
                    disabled,
                    repoIds,
                    repoId,
                    executor,
                    onPasteFiles,
                    localAttachments,
                  }) => (
                    <WYSIWYGEditor
                      placeholder="Describe the task..."
                      value={value}
                      onChange={onChange}
                      onCmdEnter={onCmdEnter}
                      disabled={disabled}
                      className="min-h-double max-h-[50vh] overflow-y-auto"
                      repoIds={repoIds}
                      repoId={repoId}
                      executor={executor}
                      autoFocus
                      onPasteFiles={onPasteFiles}
                      localAttachments={localAttachments}
                      sendShortcut={config?.send_message_shortcut}
                    />
                  )}
                  agentIcon={
                    <AgentIcon
                      agent={effectiveExecutor}
                      className="size-icon-xl"
                    />
                  }
                  onSend={handleSubmit}
                  isSending={isSubmitting}
                  disabled={!hasSelectedRepos}
                  executor={{
                    selected: effectiveExecutor,
                    options: executorOptions,
                    onChange: handleExecutorChange,
                    additionalSelected: additionalExecutors.map(
                      (e) => e.executor
                    ),
                    onToggleAdditional: handleToggleAdditional,
                  }}
                  formatExecutorLabel={toPrettyCase}
                  error={displayError}
                  repoIds={repos.map((r) => r.id)}
                  repoId={repoId}
                  modelSelector={
                    effectiveExecutor ? (
                      <ModelSelectorContainer
                        agent={effectiveExecutor}
                        workspaceId={undefined}
                        onAdvancedSettings={handleCustomise}
                        presets={variantOptions}
                        selectedPreset={selectedVariant}
                        onPresetSelect={handlePresetSelect}
                        onOverrideChange={setExecutorOverrides}
                        executorConfig={executorConfig}
                        presetOptions={presetOptions}
                      />
                    ) : undefined
                  }
                  onPasteFiles={uploadFiles}
                  localAttachments={localAttachments}
                  dropzone={{ getRootProps, getInputProps, isDragActive }}
                  onEditRepos={() => setIsSelectingRepos(true)}
                  repoSummaryLabel={repoSummaryLabel}
                  repoSummaryTitle={repoSummaryTitle}
                  linkedIssue={
                    linkedIssue?.simpleId
                      ? {
                          simpleId: linkedIssue.simpleId,
                          title: linkedIssue.title ?? '',
                          onRemove: clearLinkedIssue,
                        }
                      : null
                  }
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
