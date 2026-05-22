#include "WeatherTwinWindTrailsActor.h"

#include "Components/SceneComponent.h"
#include "DrawDebugHelpers.h"
#include "WeatherTwinDataLibrary.h"
#include "WeatherTwinGeo.h"

AWeatherTwinWindTrailsActor::AWeatherTwinWindTrailsActor()
{
    PrimaryActorTick.bCanEverTick = false;
    RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

void AWeatherTwinWindTrailsActor::BeginPlay()
{
    Super::BeginPlay();
    DrawWindTrails();
}

void AWeatherTwinWindTrailsActor::DrawWindTrails()
{
    TArray<float> UWind;
    TArray<float> VWind;
    TArray<float> WWind;
    FWeatherVolumeMeta Meta;
    if (!FWeatherTwinDataLibrary::LoadWindFrame(WindMetaPath, UWind, VWind, WWind, Meta))
    {
        UE_LOG(LogTemp, Warning, TEXT("WeatherTwin: wind volume unavailable at %s"), *WindMetaPath);
        return;
    }

    const int32 StepXY = FMath::Max(1, HorizontalStride);
    const int32 StepZ = FMath::Max(1, VerticalStride);
    int32 Trails = 0;

    for (int32 Z = 0; Z < Meta.Z; Z += StepZ)
    {
        const float HeightRatio = static_cast<float>(Z) / FMath::Max(1, Meta.Z - 1);
        const FColor Color = FLinearColor::LerpUsingHSV(FLinearColor(0.1f, 0.75f, 1.0f), FLinearColor(1.0f, 0.74f, 0.18f), HeightRatio).ToFColor(true);

        for (int32 Y = 0; Y < Meta.Y; Y += StepXY)
        {
            const float V = static_cast<float>(Y) / FMath::Max(1, Meta.Y - 1);
            for (int32 X = 0; X < Meta.X; X += StepXY)
            {
                const int32 Index = (Z * Meta.Y + Y) * Meta.X + X;
                if (!UWind.IsValidIndex(Index) || !VWind.IsValidIndex(Index) || !WWind.IsValidIndex(Index))
                {
                    continue;
                }

                const float U = static_cast<float>(X) / FMath::Max(1, Meta.X - 1);
                const FVector Start((U - 0.5f) * WeatherTwinGeo::TerrainWidthCm, (0.5f - V) * WeatherTwinGeo::TerrainDepthCm, WindBaseCm + HeightRatio * WindHeightCm);
                const FVector WindVector(UWind[Index] * TrailScaleCmPerMeterSecond, -VWind[Index] * TrailScaleCmPerMeterSecond, WWind[Index] * 16.0f);
                const FVector End = Start + WindVector;
                DrawDebugLine(GetWorld(), Start, End, Color, true, -1.0f, 0, 18.0f);
                DrawDebugPoint(GetWorld(), End, 42.0f, Color, true);
                ++Trails;
            }
        }
    }

    UE_LOG(LogTemp, Display, TEXT("WeatherTwin: drew %d HRRR wind trails from %dx%dx%d"), Trails, Meta.X, Meta.Y, Meta.Z);
}
