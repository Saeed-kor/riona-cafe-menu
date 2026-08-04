import mysql from 'mysql2/promise';

import { env } from './env.js';

const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function checkDatabaseConnection() {
  await pool.query('SELECT 1');
}

export async function closeDatabasePool() {
  await pool.end();
}

export { pool };
