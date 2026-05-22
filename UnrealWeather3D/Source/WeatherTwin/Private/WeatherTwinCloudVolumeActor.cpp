#include "WeatherTwinCloudVolumeActor.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SceneComponent.h"
#include "UObject/ConstructorHelpers.h"
#include "WeatherTwinDataLibrary.h"
#include "WeatherTwinGeo.h"

AWeatherTwinCloudVolumeActor::AWeatherTwinCloudVolumeActor()
{
    PrimaryActorTick.bCanEverTick = false;
    RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
    CloudVoxels = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("CloudVoxels"));
    CloudVoxels->SetupAttachment(RootComponent);

    static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereMesh(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
    if (SphereMesh.Succeeded())
    {
        CloudVoxels->SetStaticMesh(SphereMesh.Object);
    }
}

void AWeatherTwinCloudVolumeActor::OnConstruction(const FTransform& Transform)
{
    Super::OnConstruction(Transform);
}

void AWeatherTwinCloudVolumeActor::BeginPlay()
{
    Super::BeginPlay();
    RebuildClouds();
}

void AWeatherTwinCloudVolumeActor::RebuildClouds()
{
    TArray<uint8> Bytes;
    FWeatherVolumeMeta Meta;
    if (!FWeatherTwinDataLibrary::LoadCloudVolume(CloudMetaPath, Bytes, Meta))
    {
        UE_LOG(LogTemp, Warning, TEXT("WeatherTwin: cloud volume unavailable at %s"), *CloudMetaPath);
        return;
    }

    CloudVoxels->ClearInstances();

    const int32 StepXY = FMath::Max(1, SampleStrideXY);
    const int32 StepZ = FMath::Max(1, SampleStrideZ);

    for (int32 Z = 0; Z < Meta.Z; Z += StepZ)
    {
        const float HeightRatio = static_cast<float>(Z) / FMath::Max(1, Meta.Z - 1);
        for (int32 Y = 0; Y < Meta.Y; Y += StepXY)
        {
            const float V = static_cast<float>(Y) / FMath::Max(1, Meta.Y - 1);
            for (int32 X = 0; X < Meta.X; X += StepXY)
            {
                const int32 Index = (Z * Meta.Y + Y) * Meta.X + X;
                if (!Bytes.IsValidIndex(Index) || Bytes[Index] < DensityThreshold)
                {
                    continue;
                }

                const float U = static_cast<float>(X) / FMath::Max(1, Meta.X - 1);
                const FVector P((U - 0.5f) * WeatherTwinGeo::TerrainWidthCm, (0.5f - V) * WeatherTwinGeo::TerrainDepthCm, CloudBaseCm + HeightRatio * CloudHeightCm);
                const float Density = Bytes[Index] / 255.0f;
                const float RadiusCm = FMath::Lerp(90.0f, 240.0f, Density);
                CloudVoxels->AddInstance(FTransform(FRotator::ZeroRotator, P, FVector(RadiusCm / 50.0f)));
            }
        }
    }

    UE_LOG(LogTemp, Display, TEXT("WeatherTwin: built %d cloud voxel instances from %dx%dx%d"), CloudVoxels->GetInstanceCount(), Meta.X, Meta.Y, Meta.Z);
}
