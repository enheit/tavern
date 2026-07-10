We are about to build an group call program similar to discord, but it's focused on a small group of people (max of 10), that are communicate in voice, share their screen while playing games to other people.

User main flow.

1. User download the app for the first time.
2. User opens it asks him to enter username and password. Or create an account. If user don't have account he can create one.
3. User can create account with username, password, repeatPassword.
4. After user is asked to enter server nickname and continue.
5. On the next page if server has password it asks to enter password and continue.
6. After user is on the server page.
7. User can click on the leftsidebar to join a voice chat.
8. User can click to leave the voice chat.

Main features:

- Screen sharing (480p, 720p, 1080p, 1440p and 15/30/60 fps)
- Seperate control of stream volume and voice chat volumne
- User can individually increase or dicrease sound of each user he hear
- User can individually mute/unmute a person he don't like
- Chat must support sending regular mesages with emojies
- Voice chat
- Group chat
- Soundbar (people are allowed to upload their mp3 files max 5 min and upon clicking a button it start playing and all people within the voice chat can hear it simelteniously)
- User can join multiple servers.
- User registers via nickname + password + repeatPassword
- User login via nickname + password
- User's nickname != user display name.
- User can change their nickname
- User can change their nickname color
- User can change their avatar
- There should be support, light/dark/system mode
- There should be ukrainian/english language support
- User can start sharing screen
- User can join watchign the screan shared by other user. If user didn't press manually he do not watch.
- User should be able to watch as many shared screens as he wants.
- User should be able to switch fps, quality and resolution of shared screen on the fly
- There should be admin of the server
- Admin should be able to change the password of the server
- Admin should be able to kick user from the server
- Admin should be able to change nickname of the server (tehre should be stable server id and it's nickname unique, admin if he wants can cahnge)
- User should be able to select the source input device and output device (to choose micro and headsets he prefer)
- User should be able turn on and turn of voice cancellation
- Any user can click start voice recording and it will start recording voice and it keeps on the server. So, we can listen to it later.
- User is able to share his webcam and it appears on the same canvas as stream.
- Shared screen autolayout. Upon starting streaming the shared screen tries to position his best. If two screen are shared together they are shown side by side, if 3 than 1 at the top 2 at the bototm. if 4 then 2 at the top and 2 at the bottom. Look at screenshots.
- There should be timer how long the voice chat is active. If there is no people in voice chat than voice chat will be closed.
- There should be activity log that shows when someone entered chat, when someone left the chat. when started to share scren. when sopped to share screen.
- There should be invidual tracking for evety8ione. How many messages he send, how many hours he watched stream, how many hours he streamed (per each user indivudally). for isntnace I want to know who I watch the most.
- There shold be soundboard. Each user can upload any sound to a soundboard and edit it if he wants (trip start and end). Each uploaded soudn must keep who uplaoded it when, how many times it was played and who prssed the played in order to know what are the most popular sounds.
- Tehre should be seperate control that allow to contorl the soundbar sounds. Some poeople don't like when it too loud and other don't like when it too quite.
- There should be system notifications when somoen write in the chat.
- User can disable notificaiotns if he want
- User can receive a notificaiotn if menitoned by @nickname (indiivdual notifivaiotns are controlled separatelly)

Architecture:

- We have a server. User can join server by entering server nickaname and password
- Server must have a single voice chat and single group chat by default (make sure that if in future we want to add multiple voice or group chats our schema support it, for now we dont need it)
- There should be voice cancellation (currenlty default one provided by WebRTC)

Product Name:

- Tavern

Technologies:

- Electron
- React
- Typescript
- WebRTC
- Vite

Styles:

- Tailwindcss (v4.3)

Component Libraries:

- shadcn (based on baseui), do not use radix-based components

Testing:

- Vitest
- Playright

Cloud:

- Cloudflare

Database:

- D1

Storage:

- Cloudflare R2

CI/CD:

- GitHub Actions

Authentication:

- BetterAuth

Validation:

- Zod

Form validation:

- React Hook Form

Supported platforms:

- Linux (archlinux, ubuntu, void linux)
- macOS
- Windows (10, 11)
- Web Version

Edge Cases:

- If we doing SPA it means upon refresh we will see incorrect state and after correct one, so upon page refresh we mus show a laoidng indicator global and after only show the entire ui when everything has loaded.
