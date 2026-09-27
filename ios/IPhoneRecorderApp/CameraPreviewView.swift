import AVFoundation
import SwiftUI
import UIKit

struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.configure(session: session)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        uiView.configure(session: session)
    }
}
final class PreviewView: UIView {
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?

    override class var layerClass: AnyClass {
        AVCaptureVideoPreviewLayer.self
    }

    var videoPreviewLayer: AVCaptureVideoPreviewLayer {
        layer as! AVCaptureVideoPreviewLayer
    }

    func configure(session: AVCaptureSession) {
        videoPreviewLayer.session = session
        videoPreviewLayer.videoGravity = .resizeAspect

        if let videoDevice = AVCaptureDevice.default(
            .builtInWideAngleCamera,
            for: .video,
            position: .front
        ), rotationCoordinator?.device?.uniqueID != videoDevice.uniqueID {
            let coordinator = AVCaptureDevice.RotationCoordinator(
                device: videoDevice,
                previewLayer: videoPreviewLayer
            )
            rotationCoordinator = coordinator
            rotationObservation = coordinator.observe(
                \.videoRotationAngleForHorizonLevelPreview,
                options: [.initial, .new]
            ) { [weak self] _, _ in
                DispatchQueue.main.async {
                    self?.configureConnection()
                }
            }
        }
        configureConnection()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        configureConnection()
    }

    private func configureConnection() {
        guard let connection = videoPreviewLayer.connection else {
            return
        }
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false
        }
        guard let rotationCoordinator else {
            return
        }
        let angle = rotationCoordinator.videoRotationAngleForHorizonLevelPreview
        if connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
    }
}
