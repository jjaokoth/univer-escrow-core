import 'dart:convert';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../services/location_service.dart';
import '../services/trust_client.dart';

class SafetyNetScreen extends StatefulWidget {
  final String handshakeId;

  const SafetyNetScreen({super.key, required this.handshakeId});

  @override
  State<SafetyNetScreen> createState() => _SafetyNetScreenState();
}

class _SafetyNetScreenState extends State<SafetyNetScreen> {
  final TextEditingController _otpController = TextEditingController();
  final TrustClient _trustClient = TrustClient();

  CameraController? _cameraController;
  XFile? _photo;
  Position? _position;
  bool _isLoading = false;
  String? _statusMessage;

  @override
  void initState() {
    super.initState();
    _initializeCamera();
    _loadLocation();
  }

  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();
      if (cameras.isNotEmpty) {
        _cameraController = CameraController(
          cameras.first,
          ResolutionPreset.medium,
          enableAudio: false,
        );
        await _cameraController!.initialize();
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _statusMessage = 'Camera initialization failed. ${e.toString()}';
      });
      return;
    }

    if (!mounted) return;
    setState(() {});
  }

  Future<void> _loadLocation() async {
    final position = await LocationService.getCurrentPosition();
    if (!mounted) return;
    setState(() {
      _position = position;
      if (position == null) {
        _statusMessage = 'Location permission denied or service unavailable.';
      }
    });
  }

  Future<void> _takePicture() async {
    if (_cameraController == null || !_cameraController!.value.isInitialized) {
      return;
    }

    try {
      final photo = await _cameraController!.takePicture();
      if (!mounted) return;
      setState(() {
        _photo = photo;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to take photo: ${e.toString()}')),
      );
    }
  }

  Future<void> _verifySafetyNet() async {
    if (_otpController.text.length != 6) {
      _showMessage('Enter a valid 6-digit OTP.');
      return;
    }
    if (_photo == null) {
      _showMessage('Take a proof photo before verifying.');
      return;
    }
    if (_position == null) {
      _showMessage('Location is not available. Please enable GPS and retry.');
      return;
    }

    setState(() {
      _isLoading = true;
      _statusMessage = null;
    });

    try {
      final bytes = await File(_photo!.path).readAsBytes();
      if (!mounted) return;
      final base64Photo = base64Encode(bytes);

      final result = await _trustClient.verifyHandshake(
        handshakeId: widget.handshakeId,
        otp: _otpController.text,
        photoBase64: base64Photo,
        latitude: _position!.latitude,
        longitude: _position!.longitude,
      );
      if (!mounted) return;

      _showMessage('Verification successful: ${result['status'] ?? 'OK'}');
    } catch (e) {
      if (!mounted) return;
      _showMessage('Verification failed: ${e.toString()}');
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  void dispose() {
    _cameraController?.dispose();
    _otpController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('SafetyNet Verification')),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Verification OTP',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _otpController,
                keyboardType: TextInputType.number,
                maxLength: 6,
                decoration: const InputDecoration(
                  border: OutlineInputBorder(),
                  hintText: 'Enter 6-digit OTP',
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'Proof of Delivery',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              if (_cameraController != null &&
                  _cameraController!.value.isInitialized)
                AspectRatio(
                  aspectRatio: _cameraController!.value.aspectRatio,
                  child: CameraPreview(_cameraController!),
                )
              else
                Container(
                  height: 220,
                  decoration: BoxDecoration(
                    color: Colors.grey.shade200,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Center(
                    child: Text(
                      _statusMessage ?? 'Camera is not ready yet.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                ),
              const SizedBox(height: 12),
              ElevatedButton(
                onPressed:
                    _cameraController != null &&
                        _cameraController!.value.isInitialized
                    ? _takePicture
                    : null,
                child: const Text('Capture Proof Photo'),
              ),
              if (_photo != null) ...[
                const SizedBox(height: 12),
                Text(
                  'Captured Image',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.file(
                    File(_photo!.path),
                    height: 180,
                    width: double.infinity,
                    fit: BoxFit.cover,
                  ),
                ),
              ],
              const SizedBox(height: 16),
              const Text(
                'Location',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              Text(
                _position != null
                    ? 'Lat: ${_position!.latitude.toStringAsFixed(6)}, Lng: ${_position!.longitude.toStringAsFixed(6)}'
                    : 'Location unavailable. Please enable GPS and allow permission.',
              ),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: _isLoading ? null : _verifySafetyNet,
                child: _isLoading
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Verify Handshake'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
