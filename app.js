require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const { send } = require('process');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const mongoUrl = process.env.CURRENT_ENV === 'development' ? process.env.MONGO_LOCAL_URL : process.env.MONGO_PRODUCTION_URL;

mongoose.connect(mongoUrl).then(() => {
    console.log("mongo connected");
}).catch((err) => {
    console.log("mongo not connected", err);
})


const userSchema = new mongoose.Schema({
    device_id: String,
    socket_id: String,
    status: String,
    username: String,
    profile_image_url: String
});

const messageSchema = new mongoose.Schema({
    sender_id: String,
    recipient_id: String,
    message: String,
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);


AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
})

const s3 = new AWS.S3();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/upload_profile_image', upload.single('profile_image'), (req, res) => {

    if (req.file) {
        const fileExtension = path.extname(req.file.originalname);
        const fileName = `${crypto.randomBytes(16).toString('hex')}${fileExtension}`;
        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }
        s3.upload(params, (err, data) => {
            if (err) {
                return res.status(500).send('error uploading to aws s3');
            } else {

                const imageUrl = data.Location;
                res.json({ imageUrl: imageUrl });

            }
        })
    } else {
        res.status(400).send('no file found');
    }
})

const users = {};

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('check_registration', async (deviceId) => {
        try {
            const user = await User.findOne({ device_id: deviceId });
            if (user) {
                socket.emit('registration_status', { isRegistered: true, userName: user.username, profileImageUrl: user.profile_image_url });
            } else {
                socket.emit('registration_status', { isRegistered: false });
            }
        } catch (err) {
            console.error('Database error:', err);
        }
    });

    socket.on('register', async (deviceId, username, profileImageUrl) => {
        try {
            const user = await User.findOne({ device_id: deviceId });

            const finalProfileImageUrl = profileImageUrl !== 'undefined' ? profileImageUrl : user ? user.profile_image_url : null;

            await User.findOneAndUpdate({ device_id: deviceId }, { socket_id: socket.id, status: 'online', username: username, profile_image_url: finalProfileImageUrl }, { upsert: true, new: true });

            users[deviceId] = socket.id;
            socket.deviceId = deviceId;
            console.log('User registerd with device id: ', deviceId);


            const allUsers = await User.find();
            io.emit('users', allUsers);

        } catch (err) {
            console.error('Database error:', err);
        }
    });

    socket.on('load_users', async () => {
        const allUsers = await User.find();
        io.emit('users', allUsers);
    });

    socket.on('load_messages', async ({ sender, recipient }) => {
        const messages = await Message.find({
            $or: [
                { sender_id: sender, recipient_id: recipient },
                { sender_id: recipient, recipient_id: sender }
            ]
        });
        socket.emit('load_messages', messages);
    });

    socket.on('load_messages', async ({ sender, recipient }) => {
        const messages = await Message.find({
            $or: [
                { sender_id: sender, recipient_id: recipient },
                { sender_id: recipient, recipient_id: sender }
            ]
        });
        socket.emit('load_messages', messages);
    });

    socket.on('private_message', async ({ recipient, message }) => {
        const senderDeviceId = socket.deviceId;
        const newMessage = new Message({ sender_id: senderDeviceId, recipient_id: recipient, message });
        await newMessage.save();
        const recipientSocketId = users[recipient];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('private_message', { sender: senderDeviceId, message });
        }
    });

    socket.on('get_user_info', async (deviceId) => {
        const user = await User.findOne({ device_id: deviceId });
        if (user) {
            socket.emit('user_info', user);
        }
    });

    socket.on('get_user_status', async (deviceId) => {
        const user = await User.findOne({ device_id: deviceId });
        if (user) {
            socket.emit('user_status', { status: user.status });
        }
    });

    socket.on('typing', (recipient) => {
        const recipientSocketId = users[recipient];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('typing', socket.deviceId);
            io.emit('user_status_update', { device_id: socket.deviceId, status: 'typing' });
        }
    });

    socket.on('stop_typing', async (recipient) => {
        const recipientSocketId = users[recipient];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('stop_typing', socket.deviceId);
            const user = await User.findOne({ device_id: socket.deviceId });
            if (user) {
                io.emit('user_status_update', { device_id: socket.deviceId, status: user.status });
            }
        }
    });

    socket.on('disconnect', async () => {
        console.log('A user disconnected:', socket.id);
        if (socket.deviceId) {
            delete users[socket.deviceId];
            await User.findOneAndUpdate({ device_id: socket.deviceId }, { status: 'offline' });

            const allUsers = await User.find();
            io.emit('users', allUsers);
            io.emit('user_status_update', { device_id: socket.deviceId, status: 'offline' });
        }
    });
});

server.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});