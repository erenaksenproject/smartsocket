const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

let latestData = { monitor1:null, monitor2:null, monitor3:null, monitor4:null, device:null };

app.post('/api/data/post',(req,res)=>{
  const data = req.body;
  if(!data) return res.status(400).json({error:"Veri yok"});
  latestData = data;
  console.log("Telemetry received:",JSON.stringify(data,null,2));
  res.json({status:"ok"});
});

app.get('/api/data/get',(req,res)=>res.json(latestData));

let settings = {
  theme: "dark",
  unitMode: "A_W",
  monitorNames: ["DC Soket Çıkışı 1","DC Soket Çıkışı 2","USB-A Portu 1","USB-A Portu 2"],
  updateDelayWarn: true
};

app.get('/api/settings/get',(req,res)=>res.json(settings));
app.post('/api/settings/set',(req,res)=>{
  const newSettings = req.body;
  settings = {...settings,...newSettings};
  console.log("Settings updated:",settings);
  res.json({settings});
});

app.post('/api/log',(req,res)=>{
  console.log("Log:",req.body);
  res.json({status:"ok"});
});

app.listen(port,()=>console.log(`Server çalışıyor http://localhost:${port}`));
