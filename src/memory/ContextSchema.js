export const keys = {
  transcripts: (roomId) => `context:${roomId}:transcripts`,
  comments:    (roomId) => `context:${roomId}:comments`,
  botReplies:  (roomId) => `context:${roomId}:bot_replies`,
  meta:        (roomId) => `context:${roomId}:meta`,
  cooldown:    (roomId) => `context:${roomId}:cooldown`,
};

export const limits = {
  transcripts: 15,   
  comments:    30,   
  botReplies:  10,   
};

export const DEFAULT_TTL_SECONDS = 2 * 60 * 60;
