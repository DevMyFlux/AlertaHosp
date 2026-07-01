import { processCumulativeData } from './src/data/processor';
import Papa from 'papaparse';

fetch("https://docs.google.com/spreadsheets/d/15BmawHMQ6ucZJwe5jqksRw2ZSW55R4IszgnmbTTYWGs/export?format=csv&gid=681869284")
.then(r => r.text())
.then(t => {
  const result = Papa.parse(t, { header: true, dynamicTyping: true });
  const processed = processCumulativeData(result.data as any);
  console.log("Processed length:", processed.length);
  if (processed.length > 0) {
    console.log("First:", processed[0].timestamp);
    console.log("Last:", processed[processed.length - 1].timestamp);
  }
});
