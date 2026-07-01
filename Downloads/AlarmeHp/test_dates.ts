import Papa from "papaparse";
fetch("https://docs.google.com/spreadsheets/d/15BmawHMQ6ucZJwe5jqksRw2ZSW55R4IszgnmbTTYWGs/export?format=csv&gid=681869284")
.then(r => r.text())
.then(t => {
  const lines = t.split('\n');
  console.log("First:", lines[1]);
  console.log("Last:", lines[lines.length-2]);
});
