import logger from '../utils/logger.js';

const log = logger.child({ module: 'MongoConversationService' });
const REQUIRED_CONVERSATION_BOTS = ['aman', 'shivam', 'abhishek', 'rahul'];

export function createMongoConversationService(mongoClient, dbName = 'ai_chatbot') {
  if (!mongoClient) {
    throw new Error('MongoConversationService: mongoClient is required');
  }

  const db = mongoClient.db(dbName);

  // Ensure expected bot collections exist under conversations/<bot>
  for (const bot of REQUIRED_CONVERSATION_BOTS) {
    const botCollection = db.collection(`conversations/${bot}`);
    botCollection.createIndex({ botId: 1, roomId: 1, timestamp: -1 })
      .catch((err) => log.error({ err }, `Failed to create index on collection: conversations/${bot}`));
  }

  async function saveQA({ botId, roomId, question, questionUser, answer }) {
    try {
      const cleanBotName = (botId || 'unknown').replace('-bot', '').toLowerCase();
      const dynamicCollection = db.collection(`conversations/${cleanBotName}`);

      // Asynchronously ensure index on the dynamic collection
      dynamicCollection.createIndex({ botId: 1, roomId: 1, timestamp: -1 })
        .catch((err) => log.error({ err }, `Failed to create index on collection: conversations/${cleanBotName}`));

      const doc = {
        botId: botId || 'unknown-bot',
        roomId,
        question: question || '',
        questionUser: questionUser || 'unknown',
        answer: answer || '',
        timestamp: new Date()
      };
      const result = await dynamicCollection.insertOne(doc);
      log.debug({ id: result.insertedId, botId, roomId }, `Saved Q&A pair to MongoDB collection: ${cleanBotName}`);
      return result;
    } catch (err) {
      log.error({ err, botId, roomId }, 'Failed to save Q&A pair to MongoDB conversations');
    }
  }

  return {
    saveQA,
    db
  };
}
