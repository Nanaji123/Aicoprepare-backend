import { getInterviewDetails } from './src/services/interview.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sessionId = '936f7da2-0888-4f09-bd58-4831db082300';
  const userId = '0c4719b6-a7e0-4096-bd15-e128a541217e'; // Based on previous log
  const details = await getInterviewDetails(sessionId, userId);
  console.log('Session Details Answers length:', details.answers.length);
  if (details.answers.length > 0) {
    console.log('First answer keys:', Object.keys(details.answers[0]));
    console.log('First answer object:', details.answers[0]);
  }
}
main().catch(console.error);
