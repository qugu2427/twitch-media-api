let express = require("express");
let socket = require("socket.io");
let cors = require("cors");
const fetch = require("node-fetch");
const config = require("./config");

let app = express();
app.use(cors());

const port = process.env.PORT || 3000;
let server = app.listen(port, function () {
  console.log(`Listening to requests on port ${port}...`);
});

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
  },
});

let connections = 0;
let boos = [];
let lastYtid = "";
let queue = [];
let lastPlay = -1;
let inVideo = false;

function play() {
  console.log("playing");
  inVideo = true;
  lastPlay = Date.now();
  lastYtid = queue[0].ytid;
  io.emit("play", queue[0]);
}

function end() {
  console.log("media done");
  inVideo = false;
  queue.shift();
  boos = [];
  parseQueue();
}

function parseQueue() {
  console.log("starting queue parse");
  if (queue.length == 0) {
    console.log("queue is empty, returning");
    return;
  }
  let snapshot = -1;
  setTimeout(function () {
    play();
    snapshot = lastPlay;
  }, 7000);
  setTimeout(function () {
    if (lastPlay == snapshot) {
      end();
    } else {
      console.log("aborted timeout: skip must have happended");
    }
  }, queue[0].duration * 1000 + 7000);
}

function YTDurationToSeconds(duration) {
  let match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  match = match.slice(1).map(function (x) {
    if (x != null) {
      return x.replace(/\D/, "");
    }
  });
  let hours = parseInt(match[0]) || 0;
  let minutes = parseInt(match[1]) || 0;
  let seconds = parseInt(match[2]) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

async function enqueue(ytid, addedBy) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(ytid)) {
    console.log("enque failed - invalid ytid");
    io.emit("message", `@${addedBy} can't add ${ytid}, invalid id`);
    return;
  }
  if (queue.length - 1 == config.queueLimit) {
    io.emit("message", `@${addedBy} can't add ${ytid}, queue is full`);
    return;
  }
  if ((queue.length > 0 && queue[0].ytid == ytid) || lastYtid == ytid) {
    io.emit("message", `@${addedBy} can't add ${ytid}, media was just played`);
    return;
  }
  if (queue.length > 0 && queue[queue.length - 1].ytid == ytid) {
    io.emit("message", `@${addedBy} can't add ${ytid}, media was just added`);
    return;
  }
  let res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet%2C+contentDetails%2C+status&id=${ytid}&key=${config.ytkey}`
  );
  if (!res.ok) {
    io.emit("message", `@${addedBy} can't add ${ytid}, non ok response from youtube`);
    return;
  }
  let data = await res.json();
  if (data.items.length != 1) {
    io.emit("message", `@${addedBy} can't add ${ytid}, id not found`);
    return;
  }
  if (data.items[0].kind != "youtube#video") {
    io.emit("message", `@${addedBy} can't add ${ytid}, not a youtube#video`);
    return;
  }
  if (!data.items[0].status.embeddable) {
    io.emit("message", `@${addedBy} can't add ${ytid}, not embeddable`);
    return;
  }
  let duration = YTDurationToSeconds(data.items[0].contentDetails.duration);
  if (duration > config.durationLimit) {
    io.emit("message", `@${addedBy} can't add ${ytid}, video too long`);
    return;
  }
  let item = {
    name: data.items[0].snippet.title,
    ytid: ytid,
    duration: duration,
    addedBy: addedBy,
  };
  queue.push(item);
  io.emit("enqueue", item);
  if (queue.length == 1) {
    parseQueue();
  }
}

io.on("connection", function (socket) {
  connections++;
  io.emit("connections", connections);
  socket.emit("boos", boos.length);
  socket.emit("durationLimit", config.durationLimit);
  if (inVideo) {
    socket.emit("enqueueMany", queue);
    let item = {
      name: queue[0].name,
      ytid: queue[0].ytid,
      start: Math.ceil((Date.now() - lastPlay) / 1000),
      duration: queue[0].duration,
      title: queue[0].title,
      addedBy: queue[0].addedBy
    };
    socket.emit("play", item);
  } else if (queue.length > 0) {
    socket.emit("enqueueMany", queue.slice(1));
  }
  socket.on("disconnect", () => {
    connections--;
    io.emit("connections", connections);
  });
});

// Bot
const tmi = require("tmi.js");

const client = new tmi.Client({
  options: { debug: false },
  connection: {
    secure: true,
    reconnect: true,
  },
  identity: {
    username: config.username,
    password: config.oauth,
  },
  channels: [config.channel],
});

client.connect();

client.on("message", (channel, tags, message, self) => {
  if (message[0] != "!") {
    return;
  }
  let words = message.split(" ");
  if (words.length == 2 && words[0] == "!queue") {
    enqueue(words[1], tags["display-name"]);
  } else if (
    words.length >= 1 &&
    words[0] == "!boo" &&
    inVideo &&
    !boos.includes(tags["display-name"])
  ) {
    boos.push(tags["display-name"]);
    io.emit("boos", boos.length);
    if (boos.length >= Math.ceil(connections / 3)) {
      console.log("boo quota reached - skipping");
      lastPlay = Date.now();
      end();
    }
  } 
  // Mod commands
  let badges = tags.badges || {};
  let isBroadcaster = badges.broadcaster;
  let isMod = badges.moderator;
  let isModUp = isBroadcaster || isMod || tags["display-name"] == config.admin;
  if(!isModUp) {
    return
  }
  if (
    words.length >= 1 &&
    words[0] == "!skip" &&
    inVideo
  ) {
    console.log("mod skip - skipping");
    lastPlay = Date.now();
    end();
  } else if (words.length == 2 && words[0] == "!durationLimit") {
    let parsed = parseInt(words[1])
    if(!isNaN(parsed) && parsed >= 10 && parsed <= 3600){
      config.durationLimit = words[1];
      io.emit("durationLimit", config.durationLimit);
    } else {
      console.log("mod command denied - invalid seconds")
    }
  } else if (
    words.length >= 1 &&
    words[0] == "!patrick"
  ) {
    enqueue("kJXwPxlK8xo", tags["display-name"])
  }
});
