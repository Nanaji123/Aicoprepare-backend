import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data: sessions, error } = await supabase.from('interviews').select('*');
  if (error) console.error("Error fetching sessions:", error);
  if (sessions && sessions.length > 0) {
    const sorted = sessions.sort((a,b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    const latest = sorted[0];
    console.log('Most recent session:', latest.id, 'started_at:', latest.started_at);
    
    const { data: answers } = await supabase.from('ai_answers').select('*').eq('interview_id', latest.id);
    console.log(`Answers for session ${latest.id}:`, answers?.length);
    if (answers && answers.length > 0) {
        console.log("Sample answer:", answers[0]);
    }
    
    const { data: transcripts } = await supabase.from('transcripts').select('*').eq('interview_id', latest.id);
    console.log(`Transcripts for session ${latest.id}:`, transcripts?.length);
  }
}
main();
