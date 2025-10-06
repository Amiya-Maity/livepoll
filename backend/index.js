const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();

const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

const io = require("socket.io")(server, {
    cors: {
        origin: "http://livepoll.umeshkumar.xyz",
        methods: ["GET", "POST"],
        credentials: true
    }
})

app.use(express.json());
app.use(cors());

// ----------------------
// In-Memory Structures
// ----------------------
let activePolls = {};         // all polls (only one at a time)
let activePollTeachers = {};  // teacher socket -> pollId
let activePollStudents = {};  // student socket -> pollId
let activePollId = 'povmsifvf-vgfgb-fbgdf-fdg';        // current active pollId

// ----------------------
// Socket.IO Logic
// ----------------------
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  socket.emit('connected', { socketId: socket.id });

  // ========================
  // Create Poll (Teacher)
  // ========================
  socket.on('create-poll', () => {
    // If there’s an existing poll, close it first
    // if (activePollId && activePolls[activePollId]) {
    //   // console.log(`Closing previous poll ${activePollId}`);
    //   delete activePolls[activePollId];
    // }

    // const pollId = randomUUID();

    activePolls[pollId] = {
      students: {},
      questions: [],
      currentQuestionIndex: -1,
      lastQuestionActive: false
    };

    activePollTeachers[socket.id] = pollId;
    activePollId = pollId;

    socket.join(pollId);
    socket.emit('joined', { pollId });
    

    console.log(`Teacher created poll ${pollId}`);
  });

  // ========================
  // Add Question
  // ========================
  socket.on("add-question", ({ question, options, timer = 5 }) => {
    const pollId = activePollId;
    if (!pollId || !activePolls[pollId]) return socket.emit("error", "No active poll");

    const poll = activePolls[pollId];

    // ✅ Stop any existing timer before starting a new one
    if (poll.timerInterval) {
      clearInterval(poll.timerInterval);
      poll.timerInterval = null;
    }

    const newQuestion = {
      question,
      options: options.map((opt) => ({ ...opt, voted: 0 })),
      askedAt: Date.now(),
      timer,
      votedBy: {},
    };

    poll.questions.push(newQuestion);
    poll.currentQuestionIndex += 1;
    poll.lastQuestionActive = true;

    const currentIndex = poll.currentQuestionIndex;

    // ✅ Start the new timer interval
    poll.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - newQuestion.askedAt) / 1000);
      const timeLeft = Math.max(0, timer - elapsed);

      io.to(pollId).emit("time-left", { timeLeft });

      // Auto-stop if time runs out (in case setTimeout didn’t trigger yet)
      if (timeLeft <= 0) {
        clearInterval(poll.timerInterval);
        poll.timerInterval = null;
      }
    }, 1000);

    // ✅ Auto-end question after timer expires
    setTimeout(() => {
      if (!poll.lastQuestionActive) return; // already ended by votes
      poll.lastQuestionActive = false;

      if (poll.timerInterval) {
        clearInterval(poll.timerInterval);
        poll.timerInterval = null;
      }
        
      let correctOptionIndex = options.findIndex(opt => opt.isCorrect);
        console.log(correctOptionIndex);
      io.to(pollId).emit("question-ended-time", {option:correctOptionIndex});
      console.log("⏰ Question ended by time");
    }, timer * 1000);

    const sanitizedOptions = options.map((opt) => ({ text: opt.text }));
    io.to(pollId).emit("new-question", { question, options: sanitizedOptions, timer });

    console.log(`✅ New question added to poll ${pollId}:`, question);
  });

  // ========================
  // Student Joins Poll
  // ========================
  socket.on('join-poll', ({ name }) => {
    const pollId = activePollId;
    if (!pollId || !activePolls[pollId]) return socket.emit('error', 'No active poll available');

    activePolls[pollId].students[socket.id] = { name };
    activePollStudents[socket.id] = pollId;

    socket.join(pollId);
    socket.emit('joined', { pollId, name });
    io.to(pollId).emit('student-joined', { name });
    if (activePolls[pollId].lastQuestionActive) {
      const { question, options, askedAt, timer } = activePolls[pollId].questions[activePolls[pollId].currentQuestionIndex];
      const sanitizedOptions = options.map(opt => ({ text: opt.text }));
      // console.log(sanitizedOptions);
      socket.emit('new-question', { question, options: sanitizedOptions, timer: Math.floor(60 - ((Date.now() - askedAt) / 1000)) });
    }
    const students = Object.entries(activePolls[activePollId]?.students || {}).map(
      ([id, student]) => ({
        id,
        name: student.name,
      })
    );
    console.log(students);
    io.to(pollId).emit('participants', { students });
    console.log(`Student ${name} joined poll ${pollId}`);
  });

  // ========================
  // Student Votes
  // ========================
  socket.on("vote", ({ optionIndex }) => {
    const pollId = activePollStudents[socket.id];
    if (!pollId || !activePolls[pollId]) return socket.emit('error', 'Poll not found');

    const poll = activePolls[pollId];
    const question = poll.questions[poll.currentQuestionIndex];

    if (!poll.lastQuestionActive) return socket.emit('error', 'No active question');
    if (optionIndex < 0 || optionIndex >= question.options.length)
      return socket.emit('error', 'Invalid option');

    if (!question.votedBy) question.votedBy = {};

    if (question.votedBy[socket.id])
      return socket.emit('error', 'You have already voted for this question');

    question.options[optionIndex].voted += 1;
    question.votedBy[socket.id] = true;

    const totalVotes = Object.keys(question.votedBy).length;
    io.to(pollId).emit("vote-update", {
      options: question.options.map((opt) => ({
        id: opt.id,
        text: opt.text,
        voted: opt.voted || 0,
        percentage: totalVotes > 0 ? ((opt.voted / totalVotes) * 100).toFixed(2) : 0,
      })),
    });

    // Check if all students voted
    const allVoted = Object.keys(poll.students || {}).every(
      (studentId) => question.votedBy[studentId]
    );

    console.log("Number of students:", Object.keys(poll.students || {}).length);
    console.log("All voted:", allVoted);

    if (allVoted) {
      poll.lastQuestionActive = false;

      // ✅ Clear the running timer interval
      if (poll.timerInterval) {
        clearInterval(poll.timerInterval);
        poll.timerInterval = null;
      }

      let correctOptionIndex = question.options.findIndex(opt => opt.isCorrect);
        console.log(correctOptionIndex);
      io.to(pollId).emit("question-ended-voted", {option:correctOptionIndex});
    }
  });


  // ========================
  // Chat Message
  // ========================
  socket.on('chat-message', ({ message }) => {
    if (!activePollId || !activePolls[activePollId]) return socket.emit('error', 'Poll not found');

    io.to(activePollId).emit('chat-message', { message, sender: activePolls[activePollId].students[socket.id]?.name || 'Teacher' ,senderId:socket.id});
  });

  // ========================
  // Teacher Kickout any student
  // ========================
  socket.on('kick-student', ({ studentId }) => {

    //if (studentId in activePolls[activePollId].students) {
    //io.to(studentId).emit('kicked', 'You have been kicked out of the poll');
    delete activePollStudents[studentId];
    const targetSocket = io.sockets.sockets.get(studentId);

    if (targetSocket) {
      targetSocket.emit('kicked', {message: 'You have been kicked out of the poll'});
      targetSocket.leave(activePollId); 
    }
    delete activePolls[activePollId]?.students[studentId];
    const students = Object.entries(activePolls[activePollId]?.students || {}).map(
      ([id, student]) => ({
        id,
        name: student.name,
      })
    );
    console.log(students);
    io.to(activePollId).emit('participants', { students });
    //}
  });

  // ========================
  // participants
  // ========================
  socket.on('get-participants', () => {
    const students = Object.entries(activePolls[activePollId]?.students || {}).map(
      ([id, student]) => ({
        id,
        name: student.name,
      })
    );
    console.log(students);
    socket.emit('participants', { students });
  });

  // ========================
  // Teacher Disconnect
  // ========================
  socket.on('history', () => {
    const questions = activePolls[activePollId]?.questions;
    questions.forEach(q => {
      const totalVotes = Object.keys(q.votedBy || {}).length;
      q.options = q.options.map(opt => ({
        text: opt.text,
        voted: opt.voted || 0,
        percentage: totalVotes > 0 ? ((opt.voted / totalVotes) * 100).toFixed(2) : 0
      }));
    });
    socket.emit('history', questions || []);
    console.log(questions)
  });

  // ========================
  // Teacher Disconnect
  // ========================
  socket.on('disconnect', () => {
    const pollId = activePollTeachers[socket.id];
    if (pollId && activePolls[pollId]) {
      console.log(`Teacher disconnected. Ending poll ${pollId}`);
      delete activePolls[pollId];
      activePollId = '';
      io.to(pollId).emit('poll-ended');
    }
    delete activePollTeachers[socket.id];
    delete activePollStudents[socket.id];
  });

  // Debug logging
  socket.onAny((event, data) => {
    console.log(`Event: ${event}, Data: ${JSON.stringify(data)}`);
  });
});

