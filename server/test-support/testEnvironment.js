export const testEnvironment = Object.freeze({
  NODE_ENV: 'test',
  TRUST_PROXY: 'false',
  PORT: '3000',
  CLIENT_URL: 'http://localhost:5173',
  DB_HOST: 'localhost',
  DB_PORT: '3306',
  DB_USER: 'root',
  DB_PASSWORD: '',
  DB_NAME: 'riona_cafe_menu',
});

export function configureTestEnvironment() {
  Object.assign(process.env, testEnvironment);
}
