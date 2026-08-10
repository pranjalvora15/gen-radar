const categories = [
  "models",
  "research",
  "rag",
  "agents",
  "langchain-langgraph",
  "multimodal",
  "safety",
  "other"
];

const errorResponse = {
  type: "object",
  required: ["message"],
  properties: { message: { type: "string" } }
};

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer", minimum: 1 } }
};

const conversationParams = {
  type: "object",
  required: ["conversationId"],
  properties: {
    conversationId: {
      type: "string",
      pattern: "^[0-9a-fA-F-]{36}$"
    }
  }
};

const citation = {
  type: "object",
  required: ["title", "url", "excerpt", "sourceType"],
  properties: {
    title: { type: "string" },
    url: { type: "string" },
    excerpt: { type: "string" },
    sourceType: { type: "string", enum: ["article", "image", "video", "web"] },
    timestamp: { anyOf: [{ type: "string" }, { type: "null" }] }
  }
};

const chatMessage = {
  type: "object",
  required: ["id", "role", "content", "citations", "createdAt"],
  properties: {
    id: { type: "integer" },
    role: { type: "string", enum: ["user", "assistant"] },
    content: { type: "string" },
    answerMode: {
      anyOf: [
        {
          type: "string",
          enum: [
            "article", "general", "media", "web_search", "combined",
            "insufficient", "guardrail"
          ]
        },
        { type: "null" }
      ]
    },
    citations: { type: "array", items: citation },
    selectedMediaId: {
      anyOf: [{ type: "integer" }, { type: "null" }]
    },
    replyToMessageId: {
      anyOf: [{ type: "integer" }, { type: "null" }]
    },
    createdAt: { type: "string" }
  }
};

const articleMedia = {
  type: "object",
  required: ["id", "mediaType", "sourceUrl", "previewUrl", "sourceOrder", "status"],
  properties: {
    id: { type: "integer" },
    mediaType: { type: "string", enum: ["image", "video"] },
    sourceUrl: { type: "string" },
    previewUrl: { type: "string" },
    sourceOrder: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["available", "pending", "analyzed"] },
    analysis: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
    analysisText: { anyOf: [{ type: "string" }, { type: "null" }] }
  }
};

const articleChat = {
  type: "object",
  required: [
    "id", "canWrite", "status", "article", "messages", "media",
    "expiresAt", "createdAt", "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    canWrite: { type: "boolean" },
    status: { type: "string", enum: ["active", "closed_scope"] },
    closedReason: { anyOf: [{ type: "string" }, { type: "null" }] },
    closedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    expiresAt: { type: "string" },
    article: {
      type: "object",
      required: [
        "id", "canonicalUrl", "title", "sourceName", "processingMode",
        "suggestedQuestions", "mediaStatus"
      ],
      properties: {
        id: { type: "integer" },
        canonicalUrl: { type: "string" },
        title: { type: "string" },
        sourceName: { type: "string" },
        processingMode: { type: "string", enum: ["direct", "vector"] },
        suggestedQuestions: {
          type: "array",
          minItems: 0,
          maxItems: 3,
          items: { type: "string" }
        },
        mediaStatus: {
          type: "string",
          enum: ["pending", "processing", "ready", "partial", "failed"]
        }
      }
    },
    messages: { type: "array", items: chatMessage },
    media: { type: "array", items: articleMedia },
    createdAt: { type: "string" },
    updatedAt: { type: "string" }
  }
};

const update = {
  type: "object",
  required: [
    "id", "sourceUrl", "sourceTitle", "sourceName", "sourceSnippet",
    "displaySummary",
    "category", "keywords"
  ],
  properties: {
    id: { type: "integer" },
    sourceUrl: { type: "string" },
    sourceTitle: { type: "string" },
    sourceName: { type: "string" },
    sourceContent: { type: "string" },
    sourceSnippet: { type: "string" },
    displaySummary: { type: "string" },
    sourcePublishedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    discoveredAt: { type: "string" },
    category: { type: "string", enum: categories },
    explanation: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
    explanationStatus: {
      type: "string",
      enum: ["pending", "generating", "ready", "failed"]
    },
    keywords: { type: "array", items: { type: "string" } }
  }
};

export const listUpdatesSchema = {
  response: {
    200: {
      type: "object",
      required: ["updates", "feed"],
      properties: {
        updates: { type: "array", items: update },
        feed: {
          type: "object",
          required: ["refreshing"],
          properties: {
            refreshing: { type: "boolean" },
            lastRefreshedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
            lastError: { anyOf: [{ type: "string" }, { type: "null" }] }
          }
        }
      }
    }
  }
};

export const getUpdateSchema = {
  params: idParams,
  response: {
    200: {
      type: "object",
      required: ["update"],
      properties: { update }
    },
    404: errorResponse
  }
};

export const explainArticleSchema = {
  params: idParams,
  response: {
    200: {
      type: "object",
      required: ["explanation", "cached"],
      properties: {
        explanation: { type: "object", additionalProperties: true },
        cached: { type: "boolean" }
      }
    },
    404: errorResponse
  }
};

export const explainKeywordSchema = {
  params: idParams,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["keyword"],
    properties: {
      keyword: { type: "string", minLength: 1, maxLength: 100 }
    }
  },
  response: {
    200: {
      type: "object",
      required: ["explanation", "cached"],
      properties: {
        explanation: { type: "object", additionalProperties: true },
        cached: { type: "boolean" }
      }
    },
    400: errorResponse,
    404: errorResponse
  }
};

export const createArticleChatSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 8, maxLength: 2_000 }
    }
  },
  response: {
    201: {
      type: "object",
      required: ["conversation", "writeToken"],
      properties: {
        conversation: articleChat,
        writeToken: { type: "string" }
      }
    },
    400: errorResponse,
    422: errorResponse
  }
};

const publicChatSummary = {
  type: "object",
  required: [
    "id", "articleTitle", "articleSource", "articleUrl",
    "firstQuestion", "answerPreview", "questionCount", "updatedAt", "expiresAt"
  ],
  properties: {
    id: { type: "string" },
    articleTitle: { type: "string" },
    articleSource: { type: "string" },
    articleUrl: { type: "string" },
    firstQuestion: { type: "string" },
    answerPreview: { type: "string" },
    questionCount: { type: "integer", minimum: 1 },
    updatedAt: { type: "string" },
    expiresAt: { type: "string" }
  }
};

export const listArticleChatsSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
      offset: { type: "integer", minimum: 0, default: 0 }
    }
  },
  response: {
    200: {
      type: "object",
      required: ["chats", "hasMore"],
      properties: {
        chats: { type: "array", items: publicChatSummary },
        hasMore: { type: "boolean" }
      }
    }
  }
};

export const getArticleChatSchema = {
  params: conversationParams,
  response: {
    200: {
      type: "object",
      required: ["conversation"],
      properties: { conversation: articleChat }
    },
    404: errorResponse,
    410: errorResponse
  }
};

export const discoverArticleMediaSchema = {
  params: conversationParams,
  response: {
    200: {
      type: "object",
      required: ["claimed", "mediaStatus"],
      properties: {
        claimed: { type: "boolean" },
        mediaStatus: {
          type: "string",
          enum: ["pending", "processing", "ready", "partial", "failed"]
        }
      }
    },
    403: errorResponse,
    404: errorResponse,
    410: errorResponse
  }
};

export const askArticleQuestionSchema = {
  params: conversationParams,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: {
      question: { type: "string", minLength: 2, maxLength: 2_000 },
      selectedMediaId: { type: "integer", minimum: 1 }
    }
  },
  response: {
    200: {
      type: "object",
      required: ["message", "duplicate", "conversationStatus"],
      properties: {
        message: chatMessage,
        duplicate: { type: "boolean" },
        matchedQuestionId: {
          anyOf: [{ type: "integer" }, { type: "null" }]
        },
        conversationStatus: {
          type: "string",
          enum: ["active", "closed_scope"]
        }
      }
    },
    400: errorResponse,
    404: errorResponse,
    403: errorResponse,
    409: errorResponse,
    410: errorResponse,
    429: errorResponse,
    503: errorResponse
  }
};

const paperWorkspaceParams = {
  type: "object",
  required: ["workspaceId"],
  properties: {
    workspaceId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" }
  }
};

const paperWorkspace = {
  type: "object",
  additionalProperties: true,
  required: [
    "id", "status", "originalFilename", "currentPage", "zoom",
    "aiActionCount", "aiActionLimit", "expiresAt", "document"
  ],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["processing", "ready", "rejected", "failed"] },
    originalFilename: { type: "string" },
    currentPage: { type: "integer" },
    zoom: { type: "number" },
    aiActionCount: { type: "integer" },
    aiActionLimit: { type: "integer" },
    expiresAt: { type: "string" },
    document: { type: "object", additionalProperties: true }
  }
};

export const createPaperWorkspaceSchema = {
  headers: {
    type: "object",
    required: ["x-pdf-sha256"],
    properties: {
      "x-pdf-sha256": { type: "string", pattern: "^[a-fA-F0-9]{64}$" }
    }
  },
  response: {
    201: { type: "object", required: ["workspace"], properties: { workspace: paperWorkspace } },
    202: { type: "object", required: ["workspace"], properties: { workspace: paperWorkspace } },
    400: errorResponse,
    409: errorResponse,
    413: errorResponse,
    422: errorResponse,
    429: errorResponse,
    503: errorResponse
  }
};

export const activePaperWorkspaceSchema = {
  response: {
    200: {
      type: "object",
      required: ["workspace"],
      properties: { workspace: { anyOf: [paperWorkspace, { type: "null" }] } }
    }
  }
};

export const getPaperWorkspaceSchema = {
  params: paperWorkspaceParams,
  response: {
    200: { type: "object", required: ["workspace"], properties: { workspace: paperWorkspace } },
    403: errorResponse,
    404: errorResponse,
    410: errorResponse
  }
};

export const updatePaperReaderSchema = {
  params: paperWorkspaceParams,
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      currentPage: { type: "integer", minimum: 1, maximum: 150 },
      zoom: { type: "number", minimum: 0.5, maximum: 3 }
    },
    minProperties: 1
  },
  response: {
    200: {
      type: "object",
      required: ["expiresAt"],
      properties: { expiresAt: { type: "string" } }
    }
  }
};

export const explainPaperSelectionSchema = {
  params: paperWorkspaceParams,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["pageNumber", "selectedText"],
    properties: {
      pageNumber: { type: "integer", minimum: 1, maximum: 150 },
      selectedText: { type: "string", minLength: 1, maxLength: 8000 }
    }
  },
  response: {
    200: { type: "object", additionalProperties: true },
    422: errorResponse,
    429: errorResponse,
    503: errorResponse
  }
};

export const explainPaperFigureSchema = {
  params: paperWorkspaceParams,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["pageNumber", "imageDataUrl"],
    properties: {
      pageNumber: { type: "integer", minimum: 1, maximum: 150 },
      imageDataUrl: { type: "string", minLength: 100, maxLength: 7500000 }
    }
  },
  response: {
    200: { type: "object", additionalProperties: true },
    400: errorResponse,
    429: errorResponse,
    503: errorResponse
  }
};

export const askPaperQuestionSchema = {
  params: paperWorkspaceParams,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["question", "answerMode"],
    properties: {
      question: { type: "string", minLength: 2, maxLength: 2000 },
      answerMode: { type: "string", enum: ["paper", "general"] }
    }
  },
  response: {
    200: { type: "object", additionalProperties: true },
    422: errorResponse,
    429: errorResponse,
    503: errorResponse
  }
};

export const deletePaperWorkspaceSchema = {
  params: paperWorkspaceParams,
  response: { 204: { type: "null" } }
};
