const videoTypes = ['.mkv', '.avi', '.mp4', '.m4v', '.ts']
const subTypes = ['.srt', '.smi', '.ssa', '.ass', '.vtt', '.sub']

module.exports = {
	isVideo: file => videoTypes.some(el => file.endsWith(el)),
	isSub: file => subTypes.some(el => file.endsWith(el)),
	removeExtension: file => file.replace(new RegExp('\.' + file.split('.').pop() + '$'), ''),
}
