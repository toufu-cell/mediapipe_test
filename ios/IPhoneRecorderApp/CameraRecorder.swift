import AVFoundation
import Combine
import Foundation
import Photos

enum CameraRecorderError: Error {
    case cameraPermissionDenied
    case missingVideoDevice
    case cannotAddInput
    case cannotAddOutput
}

final class CameraRecorder: NSObject, ObservableObject, @unchecked Sendable {
    let session = AVCaptureSession()

    var onStateChange: ((Bool, URL?) -> Void)?
    var onError: ((String) -> Void)?
    var onCameraStatusChange: ((String) -> Void)?
    var onPhotoLibraryStatusChange: ((String) -> Void)?

    private let sessionQueue = DispatchQueue(label: "app.mediapipe.capture.camera")
    private let movieFileOutput = AVCaptureMovieFileOutput()
    private var isConfigured = false

    func configure() async throws {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            throw CameraRecorderError.cameraPermissionDenied
        }

        let hasAudioPermission = await AVCaptureDevice.requestAccess(for: .audio)
        if !hasAudioPermission {
            onCameraStatusChange?("Microphone denied; preview without audio")
        }

        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                do {
                    try self.configureSession(includeAudio: hasAudioPermission)
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

    func startRecording(sessionId: String) throws {
        let outputURL = try makeOutputURL(sessionId: sessionId)

        sessionQueue.async {
            if self.movieFileOutput.isRecording {
                return
            }
            self.movieFileOutput.startRecording(to: outputURL, recordingDelegate: self)
        }
    }

    func stopRecording() {
        sessionQueue.async {
            if self.movieFileOutput.isRecording {
                self.movieFileOutput.stopRecording()
            }
        }
    }

    private func configureSession(includeAudio: Bool) throws {
        guard !isConfigured else {
            return
        }

        onCameraStatusChange?("Configuring camera")
        session.beginConfiguration()
        session.sessionPreset = .high

        defer {
            session.commitConfiguration()
        }

        guard let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
            throw CameraRecorderError.missingVideoDevice
        }
        let videoInput = try AVCaptureDeviceInput(device: videoDevice)
        guard session.canAddInput(videoInput) else {
            throw CameraRecorderError.cannotAddInput
        }
        session.addInput(videoInput)

        if includeAudio {
            if let audioDevice = AVCaptureDevice.default(for: .audio) {
                let audioInput = try AVCaptureDeviceInput(device: audioDevice)
                if session.canAddInput(audioInput) {
                    session.addInput(audioInput)
                } else {
                    onCameraStatusChange?("Audio input unavailable; preview only")
                }
            } else {
                onCameraStatusChange?("No audio device; preview only")
            }
        }

        guard session.canAddOutput(movieFileOutput) else {
            throw CameraRecorderError.cannotAddOutput
        }
        session.addOutput(movieFileOutput)

        isConfigured = true
        onCameraStatusChange?("Camera configured")
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
            try FileManager.default.removeItem(at: outputURL)
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
