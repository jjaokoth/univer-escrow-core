import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { MobileEnvConfig } from '../types/mobile-env';

const CORPORATE_DARK = {
  background: '#0B1220',
  card: '#111B2E',
  card2: '#0F172A',
  border: 'rgba(255,255,255,0.10)',
  text: '#E6EEF8',
  textMuted: 'rgba(230,238,248,0.72)',
  accent: '#22C55E',
  warn: '#F59E0B',
  danger: '#EF4444',
  info: '#60A5FA',
};

function VitalFlagRow(props: {
  label: string;
  status: 'valid' | 'warning' | 'invalid';
}) {
  const color = props.status === 'valid'
    ? CORPORATE_DARK.accent
    : props.status === 'warning'
      ? CORPORATE_DARK.warn
      : CORPORATE_DARK.danger;

  const statusText = props.status === 'valid'
    ? 'VALID'
    : props.status === 'warning'
      ? 'CHECK'
      : 'INVALID';

  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.rowLabel}>{props.label}</Text>
      <View style={styles.rowSpacer} />
      <View style={[styles.badge, { borderColor: color }]}> 
        <Text style={[styles.badgeText, { color }]}>{statusText}</Text>
      </View>
    </View>
  );
}

function DataTableRow(props: {
  tenantId: string;
  networkThroughput: string;
  zkProofLatency: string;
  partitionHealth: 'good' | 'degraded';
}) {
  const healthColor = props.partitionHealth === 'good'
    ? CORPORATE_DARK.accent
    : CORPORATE_DARK.warn;

  return (
    <View style={styles.tableRow}>
      <Text style={[styles.cell, styles.tenantCell]}>{props.tenantId}</Text>
      <Text style={[styles.cell]}>{props.networkThroughput}</Text>
      <Text style={[styles.cell]}>{props.zkProofLatency}</Text>
      <View style={styles.healthCellWrap}>
        <View style={[styles.healthPill, { borderColor: healthColor }]}> 
          <Text style={[styles.healthPillText, { color: healthColor }]}>
            {props.partitionHealth === 'good' ? 'HEALTHY' : 'DEGRADED'}
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function AuditorDashboard(props: { env?: MobileEnvConfig }) {
  const env = props.env;
  const settlementDestination = env?.immutableClearingDestinationSignature
    ? `NCBA Loop Corporate Account ${env.immutableClearingDestinationSignature.destinationAccountNumber}`
    : 'NCBA Loop Corporate Account 880200283180';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Auditor Operational Dashboard</Text>
      <Text style={styles.subtitle}>Enterprise dark-mode console for validation, tenancy segregation, and immutable settlement visibility.</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>System Vitality Bar</Text>
        <Text style={styles.cardSubtitle}>Mock streaming validation states emulating Zero-Knowledge verification flags.</Text>

        <View style={styles.divider} />

        <VitalFlagRow label="ZK Proof Verification Stream" status="valid" />
        <VitalFlagRow label="Non-Interactive Privacy Token Consistency" status="valid" />
        <VitalFlagRow label="Tenant-Scope Commitment Binding" status="warning" />
        <VitalFlagRow label="Edge Validation Integrity" status="valid" />
        <VitalFlagRow label="Circuit Breaker Read Freshness" status="valid" />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Tenant Segregation Tracker</Text>
        <Text style={styles.cardSubtitle}>Isolated processing network performance mapped as operational rows.</Text>

        <View style={[styles.tableHeader, { borderColor: CORPORATE_DARK.border }]}>
          <Text style={[styles.cell, styles.tenantCell, styles.headerText]}>TENANT</Text>
          <Text style={[styles.cell, styles.headerText]}>THROUGHPUT</Text>
          <Text style={[styles.cell, styles.headerText]}>ZK LATENCY</Text>
          <Text style={[styles.cell, styles.headerText]}>HEALTH</Text>
        </View>

        <View style={styles.tableBody}>
          <DataTableRow tenantId="TNT-001" networkThroughput="412 tx/min" zkProofLatency="85 ms" partitionHealth="good" />
          <DataTableRow tenantId="TNT-014" networkThroughput="387 tx/min" zkProofLatency="102 ms" partitionHealth="good" />
          <DataTableRow tenantId="TNT-027" networkThroughput="318 tx/min" zkProofLatency="138 ms" partitionHealth="degraded" />
          <DataTableRow tenantId="TNT-039" networkThroughput="455 tx/min" zkProofLatency="79 ms" partitionHealth="good" />
        </View>
      </View>

      <View style={[styles.card, styles.ledgerCard]}>
        <Text style={styles.cardTitle}>Immutable Settlement Ledger</Text>
        <Text style={styles.ledgerSubtitle}>Visible hardcoded target destination for operator alignment. Funds settle exclusively to:</Text>

        <View style={styles.ledgerTargetWrap}>
          <Text style={styles.ledgerTarget}>{settlementDestination}</Text>
        </View>

        <View style={styles.dividerStrong} />

        <Text style={styles.ledgerFootnote}>
          The operator dashboard intentionally renders this immutable clearing destination string without indirection.
        </Text>
      </View>

      <View style={styles.footerSpace} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: CORPORATE_DARK.background,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 28,
  },
  title: {
    color: CORPORATE_DARK.text,
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
  },
  subtitle: {
    color: CORPORATE_DARK.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 14,
  },
  card: {
    backgroundColor: CORPORATE_DARK.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: CORPORATE_DARK.border,
    padding: 14,
    marginBottom: 12,
  },
  cardTitle: {
    color: CORPORATE_DARK.text,
    fontWeight: '800',
    fontSize: 16,
    marginBottom: 4,
  },
  cardSubtitle: {
    color: CORPORATE_DARK.textMuted,
    fontSize: 12,
    marginBottom: 10,
    lineHeight: 16,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginBottom: 10,
  },
  dividerStrong: {
    height: 1,
    backgroundColor: 'rgba(96,165,250,0.35)',
    marginTop: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  rowLabel: {
    color: CORPORATE_DARK.text,
    fontSize: 13,
    fontWeight: '600',
  },
  rowSpacer: {
    flex: 1,
  },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(17,27,46,0.4)',
  },
  badgeText: {
    fontWeight: '900',
    fontSize: 11,
    letterSpacing: 0.4,
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    marginBottom: 4,
  },
  tableBody: {
    paddingTop: 2,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  cell: {
    color: CORPORATE_DARK.textMuted,
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  tenantCell: {
    flex: 1.1,
    color: CORPORATE_DARK.text,
  },
  headerText: {
    color: CORPORATE_DARK.textMuted,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  healthCellWrap: {
    flex: 0.9,
    alignItems: 'flex-end',
    paddingRight: 4,
  },
  healthPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: 'rgba(15,23,42,0.35)',
  },
  healthPillText: {
    fontWeight: '900',
    fontSize: 11,
  },
  ledgerCard: {
    backgroundColor: CORPORATE_DARK.card2,
    borderColor: 'rgba(96,165,250,0.35)',
    borderWidth: 1,
  },
  ledgerSubtitle: {
    color: CORPORATE_DARK.textMuted,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 12,
  },
  ledgerTargetWrap: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(96,165,250,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.30)',
  },
  ledgerTarget: {
    color: CORPORATE_DARK.text,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  ledgerFootnote: {
    color: CORPORATE_DARK.textMuted,
    fontSize: 12,
    marginTop: 10,
    lineHeight: 16,
  },
  footerSpace: {
    height: 16,
  },
});

