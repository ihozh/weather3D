#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "WeatherTwinTypes.h"
#include "WeatherTwinRootActor.generated.h"

class AWeatherTwinTerrainActor;
class AWeatherTwinStationsActor;
class AWeatherTwinCloudVolumeActor;
class AWeatherTwinWindTrailsActor;

UCLASS()
class WEATHERTWIN_API AWeatherTwinRootActor : public AActor
{
    GENERATED_BODY()

public:
    AWeatherTwinRootActor();

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    FWeatherTwinRegion Region;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    bool bSpawnTerrain = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    bool bSpawnStations = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    bool bSpawnClouds = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    bool bSpawnWind = true;

protected:
    virtual void BeginPlay() override;

private:
    template<typename T>
    T* SpawnLayer(const TCHAR* Name);
};
