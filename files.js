const videoTypes = ['.mkv', '.avi', '.mp4', '.ts']
const subTypes = ['.srt', '.smi', '.ssa', '.ass', '.vtt']

module.exports = {
	isVideo: file => videoTypes.some(el => file.endsWith(el)),
	isSub: file => subTypes.some(el => file.endsWith(el)),
	removeExtension: file => file.replace(new RegExp('\.' + file.split('.').pop() + '$'), ''),
}
