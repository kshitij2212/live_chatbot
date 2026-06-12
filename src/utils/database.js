import mysql from 'mysql2/promise';
import 'dotenv/config';
import logger from './logger.js';

const log = logger.child({ module: 'Database' });

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  port:               Number(process.env.DB_PORT ?? '3306'),
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  connectTimeout:     15000,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  charset:            'utf8mb4',
  enableKeepAlive:    true,
});

export async function query(sql, params) {
  const connection = await pool.getConnection();
  try {
    const [results] = await connection.query(sql, params);
    return results;
  } catch (err) {
    log.error({ err, sql }, 'Database Query Error');
    throw err;
  } finally {
    connection.release();
  }
}

export async function resolveUser(userId, fallbackUsername) {
  if (!userId) {
    return { username: fallbackUsername, gender: null };
  }
  try {
    const rows = await query('SELECT username, gender FROM users WHERE id = ?', [userId]);
    if (rows && rows.length > 0) {
      return {
        username: rows[0].username || fallbackUsername,
        gender: rows[0].gender || null,
      };
    }
  } catch (err) {
    log.warn({ err, userId }, 'Failed to query user from DB, using fallback');
  }
  return {
    username: fallbackUsername,
    gender: null,
  };
}

export async function resolveActiveLiveSession(userId) {
  if (!userId) {
    return null;
  }
  try {
    const rows = await query(
      "SELECT id, channelName FROM userlive WHERE userId = ? AND status = 'live' ORDER BY id DESC LIMIT 1",
      [userId]
    );
    if (rows && rows.length > 0) {
      return {
        liveId: rows[0].id,
        roomName: rows[0].channelName,
      };
    }
  } catch (err) {
    log.warn({ err, userId }, 'Failed to query active live session from DB');
  }
  return null;
}

export default { query, resolveUser, resolveActiveLiveSession };
