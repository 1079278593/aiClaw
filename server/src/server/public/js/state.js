export function createAppState() {
  return {
    currentSessionId: null,
    sessions: [],
    lastActiveSessionId: null,
    recentModels: [],
    sessionCache: new Map(),
    currentSessionMessageCount: 0,
    currentMessages: [],

    availableProviders: [],
    providerConfigs: {},
    defaultProvider: "zai",
    defaultModel: "glm-4.7",
    defaultThinkingEffort: "off",
    currentProvider: "zai",
    currentModel: "glm-4.7",
    currentThinkingEffort: "off",
    gitSyncEnabled: false,

    isStreaming: false,
    currentRunId: null,
    lastStreamSequence: 0,
    streamingBubble: null,
    streamingReasoningBlock: null,
    currentTextSegment: null,
    pendingToolBlocks: {},
    typingPlaceholder: null,
    pendingSubmission: null,
    pendingUserBubble: null,
    currentRoundAnchor: null,
    latestUsage: null,
    isCompacting: false,
    compactingBubble: null,
    pendingImages: [],
    disconnectNotified: false,
    /**
     * 左侧面板：docs | people | reflections。
     * 只决定左栏显示哪个列表、以及发消息时附带哪类上下文，
     * 与会话无关（切面板不换会话，也不持久化）。
     */
    panel: "docs",
    personThread: null,
    reflectionPreview: null,
    afterChat: null,
    userScrolledUp: false,
    sessionLoadRequestId: null,
    visibleProcessStep: null,
    pendingProcessStep: null,
    visibleProcessSince: 0,
    processTimer: null,

    messagesEl: null,
    inputEl: null,
    sendBtn: null,
    tokenDisplayEl: null,
    compactBtnEl: null,
    modelSelectEl: null,
    thinkingEffortSelectEl: null,
    pendingImagesEl: null,
  };
}

export function clearChatElements(state) {
  state.currentRoundAnchor = null;
  state.messagesEl = null;
  state.inputEl = null;
  state.sendBtn = null;
  state.tokenDisplayEl = null;
  state.compactBtnEl = null;
  state.modelSelectEl = null;
  state.thinkingEffortSelectEl = null;
  state.pendingImagesEl = null;
}
