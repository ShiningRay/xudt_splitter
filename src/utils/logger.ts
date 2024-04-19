// src/utils/logger.ts

function infoWithTimestamp(message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[INFO] [${timestamp}] ${message}`);
  }
  
  function errorWithTimestamp(error: Error): void {
    const timestamp = new Date().toISOString();
    console.error(`[ERROR] [${timestamp}] ${error.stack || error.message}`);
  }
  
  export const logger = {
    info: infoWithTimestamp,
    error: errorWithTimestamp
  };
  