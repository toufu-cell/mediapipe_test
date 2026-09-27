import AVFoundation
import Combine
import Foundation
import Photos

enum CameraRecorderError: Error {
    case cameraPermissionDenied
    case missingVideoDevice
    case unsupportedCaptureFormat
    case cannotAddInput
    case cannotAddOutput
    case alreadyRecording
    case outputAlreadyExists
}

final class CameraRecorder: NSObject, ObservableObject, @unchecked Sendable {
    let session = AVCaptureSession()

    var onStateChange: ((Bool, URL?) -> Void)?
    var onError: ((String) -> Void)?
    var onCameraStatusChange: ((String) -> Void)?
    var onPhotoLibraryStatusChange: ((String) -> Void)?

    private let sessionQueue = DispatchQueue(label: "app.mediapipe.capture.camera")
    private let movieFileOutput = AVCaptureMovieFileOutput()
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var isConfigured = false

    func configure() async throws {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            throw CameraRecorderError.cameraPermissionDenied
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sessionQueue.async {
                do {
                    try self.configureSession()
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func startPreview() {
        sessionQueue.async {
            self.onCameraStatusChange?("Starting preview")
            if !self.session.isRunning {
                self.session.startRunning()
            }
            self.onCameraStatusChange?(self.session.isRunning ? "Preview running" : "Preview not running")
        }
    }

    func stopPreview() {
        sessionQueue.async {
            if self.session.isRunning {
                self.session.stopRunning()
            }
            self.onCameraStatusChange?("Preview stopped")
        }
    }

    func startRecording(sessionId: String) async throws {
        let outputURL = try makeOutputURL(sessionId: sessionId)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sessionQueue.async {
                guard !self.movieFileOutput.isRecording else {
                    continuation.resume(throwing: CameraRecorderError.alreadyRecording)
                    return
                }
                self.configureMovieOutputConnection()
                self.movieFileOutput.startRecording(to: outputURL, recordingDelegate: self)
                continuation.resume()
            }
        }
    }

    func validateOutputAvailable(sessionId: String) throws {
        _ = try makeOutputURL(sessionId: sessionId)
    }

    func stopRecording() {
        sessionQueue.async {
            if self.movieFileOutput.isRecording {
                self.movieFileOutput.stopRecording()
            }
        }
    }

    private func configureSession() throws {
        guard !isConfigured else {
            return
        }

        onCameraStatusChange?("Configuring camera")
        session.beginConfiguration()
        do {
            guard session.canSetSessionPreset(.inputPriority) else {
                throw CameraRecorderError.unsupportedCaptureFormat
            }
            session.sessionPreset = .inputPriority

            guard let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
                throw CameraRecorderError.missingVideoDevice
            }
            rotationCoordinator = AVCaptureDevice.RotationCoordinator(
                device: videoDevice,
                previewLayer: nil
            )
            let videoInput = try AVCaptureDeviceInput(device: videoDevice)
            guard session.canAddInput(videoInput) else {
                throw CameraRecorderError.cannotAddInput
            }
            session.addInput(videoInput)
            try configureVideoDevice(videoDevice)

            guard session.canAddOutput(movieFileOutput) else {
                throw CameraRecorderError.cannotAddOutput
            }
            session.addOutput(movieFileOutput)
            configureMovieOutputConnection()

            session.commitConfiguration()
        } catch {
            rotationCoordinator = nil
            for output in session.outputs {
                session.removeOutput(output)
            }
            for input in session.inputs {
                session.removeInput(input)
            }
            session.commitConfiguration()
            throw error
        }

        isConfigured = true
        onCameraStatusChange?("Camera configured: 1080p / 30 fps / video only")
    }

    private func configureMovieOutputConnection() {
        guard let connection = movieFileOutput.connection(with: .video) else {
            return
        }
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false
        }
        guard let rotationCoordinator else {
            return
        }
        let angle = rotationCoordinator.videoRotationAngleForHorizonLevelCapture
        if connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
    }

    private func configureVideoDevice(_ device: AVCaptureDevice) throws {
        let targetFrameRate = 30.0
        guard let format = device.formats.first(where: { format in
            let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let supportsFrameRate = format.videoSupportedFrameRateRanges.contains { range in
                range.minFrameRate <= targetFrameRate && targetFrameRate <= range.maxFrameRate
            }
            return dimensions.width == 1920 && dimensions.height == 1080 && supportsFrameRate
        }) else {
            throw CameraRecorderError.unsupportedCaptureFormat
        }

        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        device.activeFormat = format
        let frameDuration = CMTime(value: 1, timescale: 30)
        device.activeVideoMinFrameDuration = frameDuration
        device.activeVideoMaxFrameDuration = frameDuration
    }

    private func makeOutputURL(sessionId: String) throws -> URL {
        let documentsURL = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let outputURL = documentsURL.appendingPathComponent("\(sessionId).mov")
        if FileManager.default.fileExists(atPath: outputURL.path) {
            throw CameraRecorderError.outputAlreadyExists
        }
        return outputURL
    }
}

extension CameraRecorder: AVCaptureFileOutputRecordingDelegate {
    func fileOutput(
        _ output: AVCaptureFileOutput,
        didStartRecordingTo fileURL: URL,
        from connections: [AVCaptureConnection]
    ) {
        onStateChange?(true, fileURL)
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        if let error {
            onError?("Recording finished with error: \(error.localizedDescription)")
        } else {
            saveRecordingToPhotoLibrary(outputFileURL)
        }
        onStateChange?(false, outputFileURL)
    }

    private func saveRecordingToPhotoLibrary(_ fileURL: URL) {
        onPhotoLibraryStatusChange?("Saving to Photos")

        PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] status in
            guard let self else {
                return
            }

            switch status {
            case .authorized, .limited:
                PHPhotoLibrary.shared().performChanges({
                    PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: fileURL)
                }, completionHandler: { [weak self] success, error in
                    if let error {
                        self?.onPhotoLibraryStatusChange?("Photos save failed: \(error.localizedDescription)")
                    } else if success {
                        self?.onPhotoLibraryStatusChange?("Saved to Photos")
                    } else {
                        self?.onPhotoLibraryStatusChange?("Photos save failed")
                    }
                })
            case .denied, .restricted:
                onPhotoLibraryStatusChange?("Photos permission denied")
            case .notDetermined:
                onPhotoLibraryStatusChange?("Photos permission not determined")
            @unknown default:
                onPhotoLibraryStatusChange?("Photos permission unavailable")
            }
        }
    }
}
