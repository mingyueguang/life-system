import {tick} from '../server/life.mjs';
import {maintainJobs} from '../server/agent-jobs.mjs';
function run(){try{maintainJobs();const result=tick();if(result.created)console.log('Scheduled workflows:',result.created)}catch(e){console.error('Scheduler error:',e.message)}}
run();setInterval(run,30000);
