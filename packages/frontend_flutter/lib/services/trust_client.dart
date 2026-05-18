import 'dart:convert';
import 'package:http/http.dart' as http;

class TrustClient {
  TrustClient({http.Client? httpClient})
    : _httpClient = httpClient ?? http.Client();

  final http.Client _httpClient;

  static const String baseUrl =
      'https://securerise-gen-lang-client-0791519677-uc.a.run.app';

  Future<Map<String, dynamic>> verifyHandshake({
    required String handshakeId,
    required String otp,
    required String photoBase64,
    required double latitude,
    required double longitude,
  }) async {
    final uri = Uri.parse('$baseUrl/api/v1/handshake/$handshakeId/verify');
    final body = jsonEncode({
      'otp': otp,
      'safetyNetImageUrl': photoBase64,
      'location': {
        'latitude': latitude,
        'longitude': longitude,
        'timestamp': DateTime.now().toIso8601String(),
      },
    });

    final response = await _httpClient.post(
      uri,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body,
    );

    if (response.statusCode == 200 || response.statusCode == 201) {
      return jsonDecode(response.body) as Map<String, dynamic>;
    }

    throw Exception(
      'Handshake verification failed (${response.statusCode}): ${response.body}',
    );
  }
}
